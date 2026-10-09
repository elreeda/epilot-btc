/// <reference path="./.sst/platform/config.d.ts" />

/**
 * SST v4 deploy for Minute / BTC.
 *
 * Honest architecture note:
 * This app keeps a long-lived Coinbase WebSocket collector, REST recovery loop,
 * and settlement worker behind PostgreSQL advisory locks — all in one Node
 * process. That does not map cleanly to Lambda (no durable inbound WS, cold
 * starts, 15-minute limits). SST therefore deploys:
 *   - RDS Postgres (sst.aws.Postgres)
 *   - ECS Fargate service (sst.aws.Service) running the existing Dockerfile
 *   - ALB HTTPS access; SPA and API served from the same container
 *
 * Outbound Coinbase access requires NAT (ec2 NAT used here for lower demo cost).
 */
export default $config({
  app(input) {
    return {
      name: "btc-minute",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: { region: "eu-central-1" },
      },
    };
  },
  async run() {
    // NAT required: Fargate tasks in private subnets must reach Coinbase WS/REST.
    const vpc = new sst.aws.Vpc("Vpc", {
      nat: "ec2",
    });

    const database = new sst.aws.Postgres("Database", {
      vpc,
      database: "btc",
      version: "17",
      instance: "t4g.micro",
      storage: "20 GB",
      // Dev stage can still use local compose Postgres via `dev` if desired;
      // deploy stages always provision RDS.
    });

    const cluster = new sst.aws.Cluster("Cluster", { vpc });

    const api = new sst.aws.Service("Api", {
      cluster,
      architecture: "arm64",
      cpu: "0.25 vCPU",
      memory: "0.5 GB",
      image: {
        context: ".",
        dockerfile: "Dockerfile",
      },
      link: [database],
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        APP_ORIGIN: "https://epilot-btc.online",
        COOKIE_SECURE: "true",
        DB_SSL: "true",
        DB_HOST: database.host,
        DB_PORT: $interpolate`${database.port}`,
        DB_USER: database.username,
        DB_PASSWORD: database.password,
        DB_NAME: database.database,
      },
      // Keep a single task: collector/settlement use advisory locks, but one
      // always-on leader is enough for this demo and avoids duplicate WS load.
      scaling: { min: 1, max: 1 },
      loadBalancer: {
        domain: {
          name: "epilot-btc.online",
          dns: false, // Namecheap manages DNS; the certificate is validated there.
          cert: "arn:aws:acm:eu-central-1:253376448059:certificate/e039f9ec-86b5-4a57-b626-755bd44cfa42",
        },
        rules: [
          { listen: "80/http", redirect: "443/https" },
          { listen: "443/https", forward: "3000/http" },
        ],
        health: {
          "3000/http": {
            path: "/healthz",
            interval: "15 seconds",
            timeout: "5 seconds",
            healthyThreshold: 2,
            unhealthyThreshold: 3,
            successCodes: "200",
          },
        },
      },
      transform: {
        listener(args) {
          if (args.port === 80) {
            // The old ALB URL also redirects to the certificate's domain.
            args.defaultActions = [{
              type: "redirect",
              redirect: {
                host: "epilot-btc.online",
                port: "443",
                protocol: "HTTPS",
                statusCode: "HTTP_301",
              },
            }];
          }
        },
      },
      health: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        startPeriod: "90 seconds",
        interval: "30 seconds",
        retries: 3,
        timeout: "5 seconds",
      },
      logging: { retention: "1 week" },
    });

    return {
      url: api.url,
      databaseHost: database.host,
    };
  },
});
