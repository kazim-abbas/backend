const levels = ['debug', 'info', 'warn', 'error'];

function format(level, msg, meta) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta || {}),
  };
  return JSON.stringify(line);
}

const logger = {};
for (const level of levels) {
  logger[level] = (msg, meta) => {
    const out = format(level, msg, meta);
    if (level === 'error') {
      console.error(out);
    } else if (level === 'warn') {
      console.warn(out);
    } else {
      console.log(out);
    }
  };
}

module.exports = logger;
