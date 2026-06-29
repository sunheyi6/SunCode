import { describe, expect, test } from 'vitest';
import { getDropdownOpenState, useDropdown } from '../../src/renderer/composables/useDropdown';

describe('getDropdownOpenState', () => {
  test('returns a boolean open state for template bindings', () => {
    const dropdown = useDropdown(false);

    expect(getDropdownOpenState(dropdown)).toBe(false);

    dropdown.open();
    expect(getDropdownOpenState(dropdown)).toBe(true);
  });
});
