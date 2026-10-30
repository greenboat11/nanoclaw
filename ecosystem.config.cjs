module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'start.cjs',
      cwd: 'C:\\projects\\nanoclaw',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        CREDENTIAL_PROXY_PORT: '3002',
      },
      error_file: 'logs/nanoclaw.error.log',
      out_file: 'logs/nanoclaw.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 5,
      min_uptime: '10s',
    },
  ],
};
