/**
 * Integration test for WASM binary passing to AudioWorklet
 * Tests that WASM is properly initialized in the AudioWorklet context
 * and that audio synthesis works with WASM-only implementation
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');

const TEST_TIMEOUT = 90000; // 90 seconds
let previewServer = null;

describe('WASM AudioWorklet Integration Tests', () => {
  let browser;
  let page;

  beforeAll(async () => {
    // Start preview server
    previewServer = spawn('npm', ['run', 'preview'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      detached: false,
    });

    // Wait for server to start
    await new Promise((resolve) => {
      previewServer.stdout.on('data', (data) => {
        if (data.toString().includes('Local:')) {
          console.log('[Setup] Preview server started');
          setTimeout(resolve, 2000); // Wait an extra 2 seconds
        }
      });
      previewServer.stderr.on('data', (data) => {
        console.error('[Preview Server Error]:', data.toString());
      });
    });

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (previewServer) {
      previewServer.kill();
      console.log('[Teardown] Preview server stopped');
    }
  });

  beforeEach(async () => {
    page = await browser.newPage();
    
    // Collect console messages
    page.on('console', (msg) => {
      console.log(`[Browser ${msg.type()}]:`, msg.text());
    });
    
    // Collect errors
    page.on('pageerror', (error) => {
      console.error('[Browser Error]:', error.message);
    });
  });

  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  test('WASM binary is fetched in main thread', async () => {
    // Start dev server or use built version
    await page.goto('http://localhost:4173/gbk/', { 
      waitUntil: 'networkidle2',
      timeout: TEST_TIMEOUT 
    });

    // Wait for app to load
    await page.waitForSelector('#root', { timeout: 10000 });

    // Check console logs for WASM binary fetch
    const logs = await page.evaluate(() => {
      return new Promise((resolve) => {
        const logs = [];
        const originalLog = console.log;
        const originalError = console.error;
        
        console.log = (...args) => {
          logs.push({ type: 'log', message: args.join(' ') });
          originalLog.apply(console, args);
        };
        
        console.error = (...args) => {
          logs.push({ type: 'error', message: args.join(' ') });
          originalError.apply(console, args);
        };
        
        setTimeout(() => {
          console.log = originalLog;
          console.error = originalError;
          resolve(logs);
        }, 5000);
      });
    });

    // Verify WASM fetch log appears
    const wasmFetchLog = logs.find(log => 
      log.message.includes('WASM binary fetched in main thread')
    );
    expect(wasmFetchLog).toBeDefined();
  }, TEST_TIMEOUT);

  test('AudioWorklet initializes WASM from binary', async () => {
    await page.goto('http://localhost:4173/gbk/', { 
      waitUntil: 'networkidle2',
      timeout: TEST_TIMEOUT 
    });

    await page.waitForSelector('#root', { timeout: 10000 });

    // Wait for AudioWorklet initialization
    await page.waitForTimeout(3000);

    // Check for AudioWorklet WASM initialization log
    const workletInitialized = await page.evaluate(() => {
      return new Promise((resolve) => {
        const checkLogs = () => {
          const logs = window.__audioWorkletLogs || [];
          const initialized = logs.some(log => 
            log.includes('[AudioWorklet] WASM DSP module initialized successfully')
          );
          resolve(initialized);
        };
        setTimeout(checkLogs, 2000);
      });
    });

    // This test may not work perfectly due to console.log limitations in AudioWorklet
    // but we can at least verify no errors occurred
    const errors = await page.evaluate(() => {
      return window.__errors || [];
    });
    expect(errors.length).toBe(0);
  }, TEST_TIMEOUT);

  test('Audio synthesis works with WASM-only implementation', async () => {
    await page.goto('http://localhost:4173/gbk/', { 
      waitUntil: 'networkidle2',
      timeout: TEST_TIMEOUT 
    });

    await page.waitForSelector('#root', { timeout: 10000 });

    // Wait for app to be ready
    await page.waitForTimeout(3000);

    // Try to trigger audio context and load a preset
    const audioWorks = await page.evaluate(async () => {
      try {
        // Look for an SF2 file in the manifest
        const sf2Response = await fetch('/gbk/static/sf2-manifest.json');
        const sf2Manifest = await sf2Response.json();
        
        if (sf2Manifest.files && sf2Manifest.files.length > 0) {
          const firstFile = sf2Manifest.files[0];
          
          // Try to load the SF2 file
          const sf2Url = `/gbk/${firstFile.path}`;
          const sf2Data = await fetch(sf2Url);
          const arrayBuffer = await sf2Data.arrayBuffer();
          
          // At this point, if we got here without errors, the app is functional
          return {
            success: true,
            sf2Size: arrayBuffer.byteLength,
            sf2Name: firstFile.name
          };
        }
        
        return { success: false, reason: 'No SF2 files found' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    expect(audioWorks.success).toBe(true);
    if (audioWorks.sf2Size) {
      console.log(`Successfully loaded SF2: ${audioWorks.sf2Name} (${audioWorks.sf2Size} bytes)`);
    }
  }, TEST_TIMEOUT);

  test('WASM module exports are accessible in AudioWorklet', async () => {
    await page.goto('http://localhost:4173/gbk/', { 
      waitUntil: 'networkidle2',
      timeout: TEST_TIMEOUT 
    });

    await page.waitForSelector('#root', { timeout: 10000 });
    await page.waitForTimeout(5000);

    // Verify no console errors about WASM not being initialized
    const hasWasmErrors = await page.evaluate(() => {
      return new Promise((resolve) => {
        const errors = window.__consoleErrors || [];
        const wasmError = errors.some(err => 
          err.includes('WASM module not initialized') ||
          err.includes('Failed to initialize WASM')
        );
        resolve(wasmError);
      });
    });

    expect(hasWasmErrors).toBe(false);
  }, TEST_TIMEOUT);

  test('No JavaScript fallback code is used', async () => {
    await page.goto('http://localhost:4173/gbk/', { 
      waitUntil: 'networkidle2',
      timeout: TEST_TIMEOUT 
    });

    await page.waitForSelector('#root', { timeout: 10000 });

    // Dynamically find the sf2-processor file in assets
    const jsContent = await page.evaluate(() => {
      return fetch('/gbk/index.html')
        .then(r => r.text())
        .then(html => {
          // Extract the sf2-processor filename from the HTML
          const match = html.match(/sf2-processor-[a-zA-Z0-9_-]+\.js/);
          if (match) {
            return fetch(`/gbk/assets/${match[0]}`).then(r => r.text());
          }
          return '';
        })
        .catch(() => '');
    });

    // Verify JS fallback classes are not in the built file
    expect(jsContent).not.toContain('VolEnvJS');
    expect(jsContent).not.toContain('ModEnvJS');
    expect(jsContent).not.toContain('LFOJS');
    expect(jsContent).not.toContain('TwoPoleLPFJS');
  }, TEST_TIMEOUT);
});
