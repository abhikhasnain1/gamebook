import { useCallback, useEffect, useRef, useState } from "react";
import { autosave, isTauri, loadAutosave, onCapture, onCaptureError } from "../lib/native";
import { createDemoCapture } from "../lib/demoCapture";
import {
  createEmptySession,
  numberPages,
  pageFromCapture,
  pageFromExistingScreenshot,
  type CapturePayload,
  type GamebookPage,
  type GamebookSession,
} from "../types/session";

interface SessionState {
  session: GamebookSession;
  setSession: React.Dispatch<React.SetStateAction<GamebookSession>>;
  activePage: GamebookPage | null;
  setActivePage: (pageId: string) => void;
  updatePage: (pageId: string, patch: Partial<GamebookPage>) => void;
  addCapture: (capture: CapturePayload) => void;
  removePage: (pageId: string) => void;
  duplicatePage: (pageId: string) => void;
  reorderPage: (sourcePageId: string, targetPageId: string) => void;
  hydrated: boolean;
}

export function useSession(onError: (message: string) => void): SessionState {
  const [session, setSession] = useState<GamebookSession>(createEmptySession);
  const [hydrated, setHydrated] = useState(false);
  const sessionRef = useRef(session);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const addCapture = useCallback((capture: CapturePayload) => {
    setSession((current) => {
      const page = pageFromCapture(capture, current.pages.length + 1);
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        activePageId: page.id,
        pages: numberPages([...current.pages, page]),
      };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    void loadAutosave()
      .then((restored) => {
        if (cancelled) return;
        if (restored) {
          setSession(restored);
        } else if (
          import.meta.env.DEV &&
          !isTauri &&
          new URLSearchParams(window.location.search).has("demo")
        ) {
          const demo = createEmptySession();
          demo.title = "Celestial Return field notes";
          const capture = createDemoCapture();
          const firstPage = pageFromCapture(capture, 1);
          const secondPage = pageFromCapture(
            { ...capture, capturedAt: new Date(Date.now() + 1000).toISOString() },
            2,
          );
          demo.pages = [firstPage, secondPage];
          demo.activePageId = firstPage.id;
          setSession(demo);
        }
      })
      .catch((error: unknown) => onError(String(error)))
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });

    void onCapture(addCapture).then((cleanup) => cleanups.push(cleanup));
    void onCaptureError(onError).then((cleanup) => cleanups.push(cleanup));

    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [addCapture, onError]);

  useEffect(() => {
    if (!hydrated) return;
    let idleHandle: number | null = null;
    const timeout = window.setTimeout(() => {
      idleHandle = window.requestIdleCallback(() => {
        idleHandle = null;
        void autosave(sessionRef.current).catch((error: unknown) =>
          onError(String(error)),
        );
      }, { timeout: 4000 });
    }, 4000);
    return () => {
      window.clearTimeout(timeout);
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
    };
  }, [hydrated, onError, session.updatedAt]);

  const setActivePage = useCallback((pageId: string) => {
    setSession((current) => ({ ...current, activePageId: pageId }));
  }, []);

  const updatePage = useCallback((pageId: string, patch: Partial<GamebookPage>) => {
    setSession((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      pages: current.pages.map((page) =>
        page.id === pageId ? { ...page, ...patch } : page,
      ),
    }));
  }, []);

  const removePage = useCallback((pageId: string) => {
    setSession((current) => {
      const index = current.pages.findIndex((page) => page.id === pageId);
      const pages = numberPages(current.pages.filter((page) => page.id !== pageId));
      const fallback = pages[Math.min(index, pages.length - 1)] ?? null;
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        pages,
        activePageId:
          current.activePageId === pageId ? fallback?.id ?? null : current.activePageId,
      };
    });
  }, []);

  const duplicatePage = useCallback((pageId: string) => {
    setSession((current) => {
      const sourceIndex = current.pages.findIndex((page) => page.id === pageId);
      const source = current.pages[sourceIndex];
      if (!source) return current;
      const page = pageFromExistingScreenshot(source, sourceIndex + 2);
      const pages = [...current.pages];
      pages.splice(sourceIndex + 1, 0, page);
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        pages: numberPages(pages),
        activePageId: page.id,
      };
    });
  }, []);

  const reorderPage = useCallback(
    (sourcePageId: string, targetPageId: string) => {
      if (sourcePageId === targetPageId) return;
      setSession((current) => {
        const sourceIndex = current.pages.findIndex(
          (page) => page.id === sourcePageId,
        );
        const targetIndex = current.pages.findIndex(
          (page) => page.id === targetPageId,
        );
        if (sourceIndex < 0 || targetIndex < 0) return current;
        const pages = [...current.pages];
        const [moved] = pages.splice(sourceIndex, 1);
        pages.splice(targetIndex, 0, moved);
        return {
          ...current,
          updatedAt: new Date().toISOString(),
          pages: numberPages(pages),
        };
      });
    },
    [],
  );

  return {
    session,
    setSession,
    activePage:
      session.pages.find((page) => page.id === session.activePageId) ?? null,
    setActivePage,
    updatePage,
    addCapture,
    removePage,
    duplicatePage,
    reorderPage,
    hydrated,
  };
}
