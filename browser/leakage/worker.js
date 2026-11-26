/* Uses the QuTiP Virtual Lab public distribution. See runtime-provenance.json. */
const nativeFetch = self.fetch.bind(self);
const local = new URL('./', self.location.href);
let environment;
let busy = false;
let output = '';
let pythonError = '';

async function textAsset(name) {
  const response = await nativeFetch(new URL(name, local));
  if (!response.ok) throw new Error(`Could not load ${name}.`);
  return response.text();
}

function sha256Integrity(hex) {
  const octets = hex.match(/../g).map(byte => String.fromCharCode(Number.parseInt(byte, 16)));
  return `sha256-${btoa(octets.join(''))}`;
}

function receivePython(line) {
  const text = String(line);
  if (text.startsWith('__TRANS_RESULT__')) output = text.slice('__TRANS_RESULT__'.length);
  if (text.startsWith('__TRANS_ERROR__')) pythonError = text.slice('__TRANS_ERROR__'.length);
}

async function initialize(progress) {
  const [manifestText, model, basis] = await Promise.all([
    textAsset('runtime-provenance.json'), textAsset('model.py'), textAsset('waveform-basis.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  const runtime = manifest.files.find(file => file.path === 'pyjs-runtime.js');
  const pinned = new Map(manifest.files.filter(file => file.url.startsWith(manifest.distribution))
    .map(file => [file.url, sha256Integrity(file.source_bundle_sha256 ?? file.sha256)]));

  // PyJS itself fetches empack packages. Verify the official bytes before it can load them.
  self.fetch = (resource, options = {}) => {
    const url = typeof resource === 'string' ? resource : resource.url ?? resource.href;
    const integrity = pinned.get(url);
    if (!integrity) throw new Error(`The numerical runtime requested an unpinned file: ${url}`);
    return nativeFetch(resource, {...options, integrity, credentials: 'omit'});
  };

  progress('Downloading the pinned QuTiP runtime');
  const wasmURL = new URL('pyjs_runtime_browser.wasm', manifest.distribution).href;
  const [bundle, wasm] = await Promise.all([
    fetch(runtime.url).then(response => {
      if (!response.ok) throw new Error('The QuTiP JavaScript runtime is unavailable.');
      return response.text();
    }),
    fetch(wasmURL).then(response => {
      if (!response.ok) throw new Error('The QuTiP WebAssembly runtime is unavailable.');
      return response.arrayBuffer();
    }),
  ]);
  const start = bundle.indexOf('var createModule=(()=>');
  const end = bundle.indexOf('const makePyJS=', start);
  if (start < 0 || end < start) throw new Error('Unexpected QuTiP runtime format.');
  const script = URL.createObjectURL(new Blob([bundle.slice(start, end)], {type: 'text/javascript'}));
  try {
    importScripts(script);
  } finally {
    URL.revokeObjectURL(script);
  }

  progress('Loading Python, NumPy, SciPy and QuTiP');
  const pyjs = await createModule({wasmBinary: wasm, print: receivePython, printErr: () => {}});
  const packages = new URL('empack', manifest.distribution).href;
  await pyjs.bootstrap_from_empack_packed_environment(`${packages}/empack_env_meta.json`, packages, false);
  await pyjs.init();
  await pyjs.exec([
    'import json, traceback',
    '_transmon_model = {"__name__": "browser_transmon_model"}',
    `exec(${JSON.stringify(model)}, _transmon_model)`,
    `_transmon_basis = json.loads(${JSON.stringify(basis)})`,
  ].join('\n'));
  return pyjs;
}

self.onmessage = async ({data}) => {
  if (busy) return;
  busy = true;
  const progress = message => self.postMessage({type: 'progress', message});
  try {
    if (!environment) environment = await initialize(progress);
    progress('Evolving the selected pulse with QuTiP');
    output = '';
    pythonError = '';
    await environment.exec([
      'try:',
      `    _transmon_parameters = json.loads(${JSON.stringify(JSON.stringify(data.parameters))})`,
      '    _transmon_result = _transmon_model["simulate"](_transmon_parameters, _transmon_basis)',
      '    print("__TRANS_RESULT__" + json.dumps(_transmon_result, allow_nan=False))',
      'except Exception:',
      '    print("__TRANS_ERROR__" + traceback.format_exc())',
    ].join('\n'));
    if (pythonError) throw new Error(pythonError);
    if (!output) throw new Error('QuTiP returned no numerical result.');
    const result = JSON.parse(output);
    if (result.qutip_version !== '4.7.0') throw new Error('Unexpected QuTiP version.');
    self.postMessage({type: 'result', result});
  } catch (error) {
    self.postMessage({type: 'error', message: String(error.message || error)});
  } finally {
    busy = false;
  }
};
