import { ref, computed, type ComputedRef } from 'vue';

export interface DropdownState {
  isOpen: ComputedRef<boolean>;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

export function useDropdown(initialState: boolean = false): DropdownState {
  const isOpenRef = ref(initialState);

  const toggle = () => {
    isOpenRef.value = !isOpenRef.value;
  };

  const open = () => {
    isOpenRef.value = true;
  };

  const close = () => {
    isOpenRef.value = false;
  };

  return {
    isOpen: computed(() => isOpenRef.value),
    toggle,
    open,
    close,
  };
}

export function getDropdownOpenState(dropdown: DropdownState): boolean {
  return dropdown.isOpen.value;
}

export interface DropdownGroup {
  items: Map<string, DropdownState>;
  register: (key: string) => DropdownState;
  closeAll: () => void;
  toggle: (key: string) => void;
  isAnyOpen: ComputedRef<boolean>;
}

export function useDropdownGroup(): DropdownGroup {
  const items = new Map<string, DropdownState>();

  const closeAll = (exceptKey?: string) => {
    for (const [key, state] of items.entries()) {
      if (key !== exceptKey) {
        state.close();
      }
    }
  };

  const register = (key: string): DropdownState => {
    if (items.has(key)) {
      return items.get(key)!;
    }
    const state = useDropdown(false);
    const stateWithMutualExclusion: DropdownState = {
      isOpen: state.isOpen,
      toggle: () => {
        const willOpen = !state.isOpen.value;
        if (willOpen) {
          closeAll(key);
        }
        state.toggle();
      },
      open: () => {
        closeAll(key);
        state.open();
      },
      close: state.close,
    };
    items.set(key, stateWithMutualExclusion);
    return stateWithMutualExclusion;
  };

  const toggle = (key: string) => {
    const state = items.get(key);
    if (state) {
      state.toggle();
    }
  };

  const isAnyOpen = computed(() => {
    for (const state of items.values()) {
      if (state.isOpen.value) return true;
    }
    return false;
  });

  return {
    items,
    register,
    closeAll,
    toggle,
    isAnyOpen,
  };
}
