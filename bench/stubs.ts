// Tauri isn't there in a plain browser: the composer's drop listener and file picker do nothing.
export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });
export const open = async () => null;
