'use strict';

function pageTemplateFile(config) {
  return config.pageContextTranslation && config.mmproj
    ? require.resolve('../../../../quality/gemma4-final-content.jinja') : null;
}

function llamaArguments(config, port) {
  if(config.llamaLoadMode!==undefined&&config.llamaLoadMode!=='none')throw Object.assign(new Error('로컬 모델의 명시적 적재 방식은 none만 지원합니다.'),{code:'CONFIG_PATH'});
  return ['--model', config.gemmaModel, '--host', '127.0.0.1', '--port', String(port),
    '--alias', config.modelAlias ?? 'gemma4-e2b-local', '--ctx-size', config.mmproj ? '8192' : '4096', '--parallel', '1', '--n-gpu-layers', '99',
    '--threads', '4', '--reasoning', 'off', '--no-webui',
    ...(pageTemplateFile(config) ? ['--chat-template-file', pageTemplateFile(config)] : []),
    ...(config.llamaLoadMode==='none'?['--load-mode','none','--no-host']:[]),
    ...(config.mmproj ? ['--mmproj',config.mmproj,'--image-max-tokens','1024','--batch-size','4096','--ubatch-size','4096'] : [])];
}

function llamaStartupMs(config) {
  const value = config.llamaStartupMs ?? 90_000;
  if (!Number.isInteger(value) || value < 1000 || value > 300_000) {
    throw Object.assign(new Error('로컬 모델 준비 제한은 1~300초의 정수여야 합니다.'), { code: 'CONFIG_PATH' });
  }
  return value;
}

module.exports = { llamaArguments, llamaStartupMs, pageTemplateFile };
