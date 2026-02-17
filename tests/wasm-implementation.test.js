/**
 * Unit tests for WASM binary passing implementation
 * Verifies code structure without requiring a running server
 */

const fs = require('fs');
const path = require('path');

describe('WASM Binary Implementation Tests', () => {
  test('dsp-wasm-wrapper exports fetchWasmBinary function', () => {
    const wrapperPath = path.join(__dirname, '..', 'src', 'dsp-wasm-wrapper.js');
    const wrapperContent = fs.readFileSync(wrapperPath, 'utf-8');
    
    expect(wrapperContent).toContain('export async function fetchWasmBinary()');
    expect(wrapperContent).toContain('wasmBinary');
    expect(wrapperContent).toContain('glueCode');
    expect(wrapperContent).toContain('basePath');
  });

  test('App.jsx imports fetchWasmBinary instead of initDSP', () => {
    const appPath = path.join(__dirname, '..', 'src', 'App.jsx');
    const appContent = fs.readFileSync(appPath, 'utf-8');
    
    expect(appContent).toContain('import { fetchWasmBinary } from "./dsp-wasm-wrapper.js"');
    expect(appContent).toContain('const wasmData = await fetchWasmBinary()');
    expect(appContent).toContain('wasmDataRef.current = wasmData');
  });

  test('App.jsx passes WASM data to AudioWorkletNode', () => {
    const appPath = path.join(__dirname, '..', 'src', 'App.jsx');
    const appContent = fs.readFileSync(appPath, 'utf-8');
    
    expect(appContent).toContain('processorOptions:');
    expect(appContent).toContain('wasmBinary: wasmDataRef.current?.wasmBinary');
    expect(appContent).toContain('glueCode: wasmDataRef.current?.glueCode');
    expect(appContent).toContain('basePath: wasmDataRef.current?.basePath');
  });

  test('sf2-processor.js has initWasmFromBinary function', () => {
    const processorPath = path.join(__dirname, '..', 'src', 'sf2-processor.js');
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).toContain('async function initWasmFromBinary(wasmBinary, glueCode, basePath)');
    expect(processorContent).toContain('WASM binary and glue code are required');
  });

  test('sf2-processor.js constructor accepts options parameter', () => {
    const processorPath = path.join(__dirname, '..', 'src', 'sf2-processor.js');
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).toContain('constructor(options)');
    expect(processorContent).toContain('super(options)');
    expect(processorContent).toContain('options?.processorOptions');
  });

  test('sf2-processor.js calls initWasmFromBinary in constructor', () => {
    const processorPath = path.join(__dirname, '..', 'src', 'sf2-processor.js');
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).toContain('this.initPromise = initWasmFromBinary');
    expect(processorContent).toContain('wasmBinary');
    expect(processorContent).toContain('glueCode');
  });

  test('sf2-processor.js does not contain JavaScript fallback classes', () => {
    const processorPath = path.join(__dirname, '..', 'src', 'sf2-processor.js');
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).not.toContain('class VolEnvJS');
    expect(processorContent).not.toContain('class ModEnvJS');
    expect(processorContent).not.toContain('class LFOJS');
    expect(processorContent).not.toContain('class TwoPoleLPFJS');
  });

  test('sf2-processor.js WASM classes throw errors when WASM not initialized', () => {
    const processorPath = path.join(__dirname, '..', 'src', 'sf2-processor.js');
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).toContain("throw new Error('WASM module not initialized')");
  });

  test('Built dist includes WASM files', () => {
    const distPath = path.join(__dirname, '..', 'dist');
    const wasmPath = path.join(distPath, 'dsp.wasm');
    const jsPath = path.join(distPath, 'dsp.js');
    
    expect(fs.existsSync(wasmPath)).toBe(true);
    expect(fs.existsSync(jsPath)).toBe(true);
    
    const wasmStats = fs.statSync(wasmPath);
    expect(wasmStats.size).toBeGreaterThan(0);
    
    const jsStats = fs.statSync(jsPath);
    expect(jsStats.size).toBeGreaterThan(0);
  });

  test('Built sf2-processor does not include JS fallback code', () => {
    const distPath = path.join(__dirname, '..', 'dist', 'assets');
    const files = fs.readdirSync(distPath);
    const processorFile = files.find(f => f.startsWith('sf2-processor-') && f.endsWith('.js'));
    
    expect(processorFile).toBeDefined();
    
    const processorPath = path.join(distPath, processorFile);
    const processorContent = fs.readFileSync(processorPath, 'utf-8');
    
    expect(processorContent).not.toContain('VolEnvJS');
    expect(processorContent).not.toContain('ModEnvJS');
    expect(processorContent).not.toContain('LFOJS');
    expect(processorContent).not.toContain('TwoPoleLPFJS');
  });
});
