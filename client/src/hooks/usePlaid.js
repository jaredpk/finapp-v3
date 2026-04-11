import { useState, useCallback } from "react";
import { usePlaidLink } from "react-plaid-link";
import { createLinkToken, exchangePublicToken } from "../api.js";

export function usePlaidConnect(onSuccess) {
  const [linkToken, setLinkToken] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const openPlaid = useCallback(async () => {
    setConnecting(true);
    try {
      const { link_token } = await createLinkToken();
      setLinkToken(link_token);
    } catch (e) {
      console.error(e);
      setConnecting(false);
    }
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (public_token, metadata) => {
      await exchangePublicToken(public_token);
      setLinkToken(null);
      setConnecting(false);
      onSuccess?.();
    },
    onExit: () => {
      setLinkToken(null);
      setConnecting(false);
    },
  });

  // Auto-open once token is ready
  if (linkToken && ready) {
    open();
  }

  return { openPlaid, connecting };
}
