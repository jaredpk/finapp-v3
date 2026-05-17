import { useState, useCallback, useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";
import { createLinkToken, exchangePublicToken } from "../api.js";

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
