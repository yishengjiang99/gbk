/**
 * Tests verifying that useEffect hooks do not trigger unnecessary re-renders
 * on noteOn and noteOff calls from midiReader.
 */

const fs = require('fs');
const path = require('path');

describe('useEffect re-render optimisations', () => {
  let midireaderContent;
  let appContent;

  beforeAll(() => {
    midireaderContent = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'midireader.jsx'),
      'utf-8'
    );
    appContent = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'App.jsx'),
      'utf-8'
    );
  });

  // --- CcKnob (midireader.jsx) -------------------------------------------------

  test('CcKnob pointermove/pointerup useEffect has an empty dependency array', () => {
    // The effect must end with `}, []);` so it only runs once on mount,
    // preventing event-listener churn on every setSongTime tick.
    expect(midireaderContent).toMatch(/window\.addEventListener\("pointermove"[\s\S]*?\},\s*\[\]\)/);
  });

  test('CcKnob stores onChange in a ref to avoid stale closures', () => {
    expect(midireaderContent).toContain('onChangeRef');
    expect(midireaderContent).toContain('onChangeRef.current = onChange');
  });

  test('CcKnob stores disabled in a ref to avoid stale closures', () => {
    expect(midireaderContent).toContain('disabledRef');
    expect(midireaderContent).toContain('disabledRef.current = disabled');
  });

  test('CcKnob onPointerMove and onPointerUp are defined inside the useEffect', () => {
    // Handlers are defined inside the effect body so the stable closure captures refs.
    const effectMatch = midireaderContent.match(
      /useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)window\.addEventListener\("pointermove"/
    );
    expect(effectMatch).not.toBeNull();
    const effectBody = effectMatch[1];
    expect(effectBody).toContain('const onPointerMove');
    expect(effectBody).toContain('const onPointerUp');
  });

  // --- App.jsx selectedLayer ---------------------------------------------------

  test('App.jsx does not use useState for selectedLayer', () => {
    // selectedLayer is now derived via useMemo, no separate useState call.
    expect(appContent).not.toMatch(
      /const\s*\[\s*selectedLayer\s*,\s*setSelectedLayer\s*\]\s*=\s*useState\s*\(\s*null\s*\)/
    );
  });

  test('App.jsx derives selectedLayer with useMemo', () => {
    expect(appContent).toContain('const selectedLayer = useMemo(');
  });

  test('App.jsx has no useEffect that calls setSelectedLayer', () => {
    // The old pattern used a useEffect + setState causing a double render on every
    // midiNote / midiVelocity change.  That effect must be gone.
    const effectPattern = /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?setSelectedLayer[\s\S]*?\},\s*\[programDetails,\s*midiNote,\s*midiVelocity\]/;
    expect(appContent).not.toMatch(effectPattern);
  });

  test('App.jsx tracks user layer selection separately from auto-selection', () => {
    expect(appContent).toContain('userSelectedLayer');
    expect(appContent).toContain('setUserSelectedLayer');
  });

  test('App.jsx setSelectedLayer wrapper stores current midiNote and midiVelocity', () => {
    // When the user clicks a layer the helper captures the active note so the
    // useMemo can determine whether to return the user's choice or the auto-selected one.
    expect(appContent).toMatch(
      /setUserSelectedLayer\s*\(\s*\{\s*layer\s*,\s*midiNote\s*,\s*midiVelocity\s*\}\s*\)/
    );
  });
});
