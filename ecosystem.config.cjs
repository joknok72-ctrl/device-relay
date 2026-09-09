module.exports = {
  apps: [{
    name: 'device-relay',
    script: 'npx',
    args: 'wrangler dev --ip 0.0.0.0 --port 3000',
    cwd: '/home/user/webapp',
    env: { NODE_ENV: 'development', NODE_OPTIONS: '--max-old-space-size=384' },
    watch: false, instances: 1, exec_mode: 'fork'
  }]
}
