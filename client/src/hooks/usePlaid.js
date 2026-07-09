import { useState, useCallback, useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";
import { createLinkToken, exchangePublicToken, createUpdateLinkToken } from "../api.js";

const LINK_TOKEN_KEY = "plaid_link_token";

export function usePlaidConnect(onSuccess) {
  const isOAuthReturn = window.location.href.includes("oauth_state_id");
  const receivedRedirectUri = isOAuthReturn ? window.location.href : undefined;

  const [linkToken, setLinkToken] = useState(() =>
    isOAuthReturn ? sessionStorage.getItem(LINK_TOKEN_KEY) : null
  );
  const [connecting, setConnecting] = useState(isOAuthReturn);

  const openPlaid = useCallback(async () => {
    setConnecting(true);
    try {
      const { link_token } = await createLinkToken();
      sessionStorage.setItem(LINK_TOKEN_KEY, link_token);
      setLinkToken(link_token);
    } catch (e) {
      console.error(e);
      setConnecting(false);
    }
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri,
    onSuccess: async (public_token) => {
      sessionStorage.removeItem(LINK_TOKEN_KEY);
      if (isOAuthReturn) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      const data = await exchangePublicToken(public_token);
      setLinkToken(null);
      setConnecting(false);
      onSuccess?.(data?.newAccounts || []);
    },
    onExit: () => {
      sessionStorage.removeItem(LINK_TOKEN_KEY);
      setLinkToken(null);
      setConnecting(false);
    },
    onError: (err) => {
      console.error("Plaid Link error:", err);
      sessionStorage.removeItem(LINK_TOKEN_KEY);
      setConnecting(false);
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  return { openPlaid, connecting };
}

export function usePlaidUpdateLink(onSuccess) {
  const [linkToken, setLinkToken] = useState(null);
  const [updating, setUpdating] = useState(false);

  const openUpdate = useCallback(async (item_id) => {
    setUpdating(true);
    try {
      const { link_token, error } = await createUpdateLinkToken(item_id);
      if (error) throw new Error(error);
      setLinkToken(link_token);
    } catch (e) {
      console.error("Failed to create update link token:", e);
      setUpdating(false);
    }
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => {
      setLinkToken(null);
      setUpdating(false);
      onSuccess?.();
    },
    onExit: () => {
      setLinkToken(null);
      setUpdating(false);
    },
    onError: (err) => {
      console.error("Plaid update error:", err);
      setLinkToken(null);
      setUpdating(false);
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  return { openUpdate, updating };
}
