const BOOLEAN_FLAGS = new Set([
  'allow-action', 'allow-ours-last', 'allow-positive', 'auto', 'brief', 'contains',
  'dry-run', 'full', 'has-remote', 'help', 'jd', 'override-severe-lock',
]);

function parseCliArgs(argv = process.argv.slice(3)) {
  const options = {};
  const flags = new Set();
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index]);
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.add(body);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      options[body] = String(next);
      index++;
    } else {
      options[body] = '';
    }
  }
  return { options, flags, positionals };
}

const arg = name => parseCliArgs().options[name] || '';
const positionals = (argv = process.argv.slice(3)) => parseCliArgs(argv).positionals;
const positional = (index = 0) => positionals()[index] || '';
const hasFlag = name => parseCliArgs().flags.has(name);
const jobIdOf = text => String(text || '').match(/zhipin\.com\/job_detail\/([^/?#]+?)\.html/i)?.[1] || '';
const isRealJobUrl = text => /zhipin\.com\/job_detail\/[\w~-]+\.html(?:[?#]|$)/i.test(String(text || ''));

module.exports = { parseCliArgs, arg, positionals, positional, hasFlag, jobIdOf, isRealJobUrl };
