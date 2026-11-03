// How something outside the transcript, such as the context inspector in the status bar, points at a place in it.
import { createContext, useContext } from "react";

/**
 * Scrolls the pane's transcript to the first message Hermes stored at or after `at` (Unix ms), or to its first
 * message without one, marks it, and says whether it found one in the history loaded.
 */
export type ShowInChat = (at?: number) => boolean;

export const ShowInChatContext = createContext<ShowInChat | undefined>(undefined);
export const useShowInChat = () => useContext(ShowInChatContext);
