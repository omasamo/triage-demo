// Downloads the local models (GGUF, 4-bit) into ~/.triage-demo/models.
//   npm run models:pull           # Qwen3.5-2B only (~1.5 GB): email triage and chat
//   npm run models:pull -- large  # also Qwen3.5-4B (~3 GB) for better chat on 16 GB machines
import { LocalModels } from '../src/node/llm.ts';
import { hardwareInfo } from '../src/node/config.ts';

const which: ('small' | 'large')[] = process.argv.includes('large') ? ['small', 'large'] : ['small'];
const m = new LocalModels();
const hw = hardwareInfo();
console.log(`Machine: ${hw.platform}, ${hw.ramGb} GB RAM. Downloading ${which.join(' + ')} model(s) to ${m.dir}`);
if (!which.includes('large') && hw.recommendedChat === 'large') console.log('Tip: this machine has 16 GB+ RAM; `npm run models:pull -- large` adds the 4B chat model.');
await m.pull(which);
console.log('Done:', m.files);
