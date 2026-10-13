import { readFile, writeFile } from 'node:fs/promises';
import { compareRuns, loadComparisonRun } from './compare.mjs';
const [beforeFolder, afterFolder, output, optionsFile] = process.argv.slice(2);
if (!beforeFolder || !afterFolder || !output) {
  console.error('Usage: node src/compare-cli.mjs before-run after-run new-report.json [options.json]');
  process.exitCode = 2;
} else {
  try {
    const options = optionsFile ? JSON.parse(await readFile(optionsFile, 'utf8')) : {};
    const [before, after] = await Promise.all([loadComparisonRun(beforeFolder), loadComparisonRun(afterFolder)]);
    const report = compareRuns(before, after, options);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, comparable: report.comparable, sameConditions: report.sameConditions ?? false }));
    if (!report.comparable) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
