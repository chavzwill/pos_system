'use strict';

const { spawnSync } = require('child_process');

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid disposable certification port: ${value}`);
  }
  return String(port);
}

function probePort(port, cwd) {
  const result = spawnSync(process.execPath, ['-e', `
    const net=require('net');
    const server=net.createServer();
    server.once('error',()=>process.exit(1));
    server.listen(${Number(port)},'127.0.0.1',()=>server.close(()=>process.exit(0)));
  `], { cwd, encoding: 'utf8' });
  return result.status === 0;
}

function selectFreePort(cwd, requestedPort) {
  if (requestedPort) {
    const port = validatePort(requestedPort);
    if (!probePort(port, cwd)) throw new Error(`Port ${port} is already in use or unavailable`);
    return port;
  }

  const result = spawnSync(process.execPath, ['-e', `
    const net=require('net');
    const server=net.createServer();
    server.once('error',err=>{console.error(err.code||err.message);process.exit(1);});
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      process.stdout.write(String(port));
      server.close(()=>process.exit(0));
    });
  `], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Unable to select a free disposable certification port: ${String(result.stderr || '').trim()}`);
  }
  const port = validatePort(String(result.stdout || '').trim());
  if (!probePort(port, cwd)) throw new Error(`Selected port ${port} became unavailable before certification startup`);
  return port;
}

module.exports = { selectFreePort, probePort, validatePort };
