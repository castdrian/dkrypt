<script lang="ts">
  import { startAuthentication } from '@simplewebauthn/browser';
  import { ChevronDown, Eye, EyeOff, KeyRound, Lock } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Label from '#lib/components/ui/Label.svelte';
  import Separator from '#lib/components/ui/Separator.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { loginRoot, refreshSession, sessionState } from '#lib/session.svelte';
  import { cn } from '#lib/utils';
  import LegalLinks from '#components/LegalLinks.svelte';

  let password = $state('');
  let loginError = $state('');
  let mfaToken = $state('');
  let mfaRequired = $state(false);
  let attemptsRemaining = $state<number | undefined>(undefined);
  let detailsOpen = $state(!sessionState.githubOauthEnabled && !sessionState.discordOauthEnabled);
  let oauthError = $state('');
  let submitting = $state(false);
  let showPassword = $state(false);
  let passwordEl: HTMLInputElement | undefined = $state();
  let signupProvider = $state<'github' | 'discord' | undefined>();
  let signupReturnTo = $state<string | undefined>();
  let signupChallengeEl: HTMLDivElement | undefined = $state();
  let signupChallengeError = $state('');
  let signupChallengeSubmitting = $state(false);
  let signupChallengeWidgetId: string | undefined;

  $effect(() => {
    if (detailsOpen) passwordEl?.focus();
  });

  const OAUTH_ERROR_MESSAGES: Record<string, string | ((user: string | null) => string)> = {
    state_mismatch: 'Sign-in session expired - please try again.',
    disabled: "GitHub sign-in isn't configured.",
    failed: 'GitHub sign-in failed - check the server logs.',
    discord_disabled: "Discord sign-in isn't configured.",
    discord_failed: 'Discord sign-in failed - check the server logs.',
    signup_email_unverified: 'New accounts need a verified GitHub or Discord email. Temporary email services cannot create accounts.',
    signup_email_in_use: 'This verified email already has an account. Sign in to it, then connect the other sign-in method in Settings.',
    signup_limited: 'Too many new accounts were created from this network recently. Try again later or sign in to your existing account.',
    signup_verification_required: 'Complete this quick check to finish creating your account.',
    signup_verification_failed: 'The account check expired or could not be verified. Please try again.',
    signup_verification_unavailable: 'New account creation is temporarily unavailable because the required signup check is not configured. Existing accounts can still sign in.',
  };

  $effect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('auth_error');
    if (code === 'signup_verification_required') {
      const provider = params.get('signup_provider');
      if (provider === 'github' || provider === 'discord') {
        signupProvider = provider;
        signupReturnTo = params.get('return_to') ?? undefined;
      }
    }
    if (code) {
      const message = OAUTH_ERROR_MESSAGES[code];
      oauthError = typeof message === 'function' ? message(params.get('user')) : (message ?? 'GitHub sign-in failed.');
      history.replaceState(null, '', location.pathname);
    }
  });

  $effect(() => {
    const provider = signupProvider;
    const siteKey = sessionState.signupTurnstileSiteKey;
    const container = signupChallengeEl;
    if (!provider || !siteKey || !container || typeof window === 'undefined') return;
    let cancelled = false;
    let widgetId: string | undefined;

    const render = async () => {
      try {
        if (!window.turnstile) {
          let script = document.querySelector<HTMLScriptElement>('script[data-dkrypt-turnstile]');
          if (!script) {
            script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.defer = true;
            script.dataset.dkryptTurnstile = 'true';
            document.head.append(script);
          }
          await new Promise<void>((resolve, reject) => {
            if (window.turnstile) return resolve();
            script!.addEventListener('load', () => resolve(), { once: true });
            script!.addEventListener('error', () => reject(new Error('Could not load account verification.')), { once: true });
          });
        }
        if (cancelled || !window.turnstile) return;
        widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          action: 'signup',
          callback: (token) => void finishSignupChallenge(provider, token),
          'error-callback': () => (signupChallengeError = 'The account check could not load. Please retry.'),
          'expired-callback': () => (signupChallengeError = 'The account check expired. Please complete it again.'),
        });
        signupChallengeWidgetId = widgetId;
      } catch (error) {
        signupChallengeError = error instanceof Error ? error.message : 'Could not load account verification.';
      }
    };

    void render();
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  });

  async function finishSignupChallenge(provider: 'github' | 'discord', token: string): Promise<void> {
    signupChallengeSubmitting = true;
    signupChallengeError = '';
    try {
      const response = await fetch('/v1/auth/signup-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? 'Account verification failed.');
      }
      const returnTo = signupReturnTo ?? (new URLSearchParams(location.search).get('continue') === 'decrypt' ? '/?continue=decrypt' : undefined);
      const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
      window.location.assign(`/v1/auth/${provider}/login${query}`);
    } catch (error) {
      signupChallengeError = error instanceof Error ? error.message : 'Account verification failed.';
      if (signupChallengeWidgetId) window.turnstile?.reset(signupChallengeWidgetId);
      signupChallengeSubmitting = false;
    }
  }

  async function submit(): Promise<void> {
    submitting = true;
    try {
      const result = await loginRoot(password, mfaToken);
      if (!result.ok) {
        loginError = result.error ?? 'Wrong password.';
        mfaRequired = result.code === 'mfa_required' || mfaRequired;
        attemptsRemaining = result.attemptsRemaining;
      } else {
        attemptsRemaining = undefined;
        mfaToken = '';
        mfaRequired = false;
      }
    } finally {
      submitting = false;
    }
  }

  async function submitPasskey(): Promise<void> {
    submitting = true;
    loginError = '';
    try {
      const optionsResponse = await fetch('/v1/auth/passkeys/options', { method: 'POST' });
      if (!optionsResponse.ok) throw new Error('Passkey sign-in is unavailable.');
      const credential = await startAuthentication({ optionsJSON: await optionsResponse.json() });
      const verifyResponse = await fetch('/v1/auth/passkeys/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      });
      if (!verifyResponse.ok) {
        const body = (await verifyResponse.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? 'Passkey sign-in failed.');
      }
      await refreshSession();
    } catch (error) {
      loginError = error instanceof Error ? error.message : 'Passkey sign-in was canceled.';
    } finally {
      submitting = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') void submit();
  }

  function oauthLoginUrl(provider: 'github' | 'discord'): string {
    const params = new URLSearchParams(location.search);
    const returnTo = params.get('return_to') ?? (params.get('continue') === 'decrypt' ? '/?continue=decrypt' : undefined);
    return `/v1/auth/${provider}/login${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`;
  }
</script>

<div
  class="flex min-h-screen flex-col items-center justify-center p-6"
  style="background: radial-gradient(circle at 50% 15%, color-mix(in srgb, var(--color-panel) 60%, var(--color-bg)) 0%, var(--color-bg) 60%);"
>
  <h1 class="mb-8 text-3xl font-semibold tracking-tight sm:text-4xl">dkrypt</h1>

  <div class="w-full max-w-[380px]">
    <Card id="sign-in" class="w-full px-8 py-9 text-center shadow-2xl">
    <div class="bg-accent shadow-accent/35 mx-auto mb-5 flex h-[60px] w-[60px] items-center justify-center rounded-2xl shadow-xl">
      <Lock class="h-7 w-7 text-white" />
    </div>
    <h2 class="mb-6.5 text-[19px] font-semibold">Sign in</h2>

    {#if sessionState.githubOauthEnabled && !signupProvider}
      <a
        href={oauthLoginUrl('github')}
        class={cn(buttonVariants('github'), 'w-full')}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path
            d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
          />
        </svg>
        Sign in with GitHub
      </a>
    {/if}
    {#if sessionState.discordOauthEnabled && !signupProvider}
      <a
        href={oauthLoginUrl('discord')}
        class={cn(buttonVariants('discord'), 'mt-3 w-full')}
      >
        <svg width="20" height="15" viewBox="0 0 64 48" fill="none" aria-hidden="true">
          <path
            d="M40.575 0C39.9562 1.09866 39.4006 2.2352 38.8954 3.397C34.0967 2.67719 29.2096 2.67719 24.3982 3.397C23.9057 2.2352 23.3374 1.09866 22.7186 0C18.2104 0.770324 13.8157 2.12155 9.64839 4.02841C1.38951 16.2652 -0.845688 28.1863 0.265599 39.9432C5.10222 43.517 10.5197 46.2447 16.2909 47.9874C17.5916 46.2447 18.7407 44.3883 19.7257 42.4562C17.8568 41.7616 16.0509 40.8903 14.3208 39.88C14.7755 39.5517 15.2175 39.2107 15.6468 38.8824C25.7873 43.6559 37.5316 43.6559 47.6847 38.8824C48.1141 39.236 48.5561 39.577 49.0107 39.88C47.2806 40.9029 45.4748 41.7616 43.5931 42.4688C44.5781 44.4009 45.7273 46.2573 47.028 48C52.7991 46.2573 58.2167 43.5422 63.0533 39.9684C64.3666 26.3299 60.8055 14.5099 53.6452 4.04104C49.4905 2.13418 45.0959 0.782952 40.5876 0.0252565L40.575 0ZM21.1401 32.7072C18.0209 32.7072 15.4321 29.8785 15.4321 26.3804C15.4321 22.8824 17.9199 20.041 21.1275 20.041C24.3351 20.041 26.886 22.895 26.8354 26.3804C26.7849 29.8658 24.3224 32.7072 21.1401 32.7072ZM42.1788 32.7072C39.047 32.7072 36.4834 29.8785 36.4834 26.3804C36.4834 22.8824 38.9712 20.041 42.1788 20.041C45.3864 20.041 47.9246 22.895 47.8741 26.3804C47.8236 29.8658 45.3611 32.7072 42.1788 32.7072Z"
            fill="white"
          />
        </svg>
        Sign in with Discord
      </a>
    {/if}
    {#if signupProvider}
      <div class="mt-4 flex flex-col items-center gap-3">
        <p class="text-xs text-muted">Verify once to complete your {signupProvider === 'github' ? 'GitHub' : 'Discord'} sign-up.</p>
        <div bind:this={signupChallengeEl} class="min-h-[65px]"></div>
        {#if signupChallengeSubmitting}<p class="text-xs text-muted">Finishing sign-in…</p>{/if}
        {#if signupChallengeError}<p class="text-xs text-err" role="alert">{signupChallengeError}</p>{/if}
        <a class="text-xs text-muted underline hover:text-text" href="/">Use an existing account instead</a>
      </div>
    {/if}
    <Button variant="secondary" class="mt-3 w-full" loading={submitting} onclick={() => void submitPasskey()}>
      <KeyRound class="h-4 w-4" />
      Use a passkey
    </Button>
    {#if oauthError}
      <div class="mt-3.5 text-[12.5px] text-err">{oauthError}</div>
    {/if}

    {#if sessionState.githubOauthEnabled || sessionState.discordOauthEnabled}
      <Separator class="my-4" />
    {/if}

    <details bind:open={detailsOpen} class="group mt-4.5 text-left">
      <summary
        class={cn(
          'flex cursor-pointer list-none items-center justify-center gap-1 pt-2.5 text-center text-[12.5px] text-muted select-none hover:text-text',
          !sessionState.githubOauthEnabled && !sessionState.discordOauthEnabled && 'hidden',
        )}
      >
        Sign in with root password
        <ChevronDown class="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div class="pt-1.5" class:mt-1.5={detailsOpen}>
        <Label for="password" class="mb-1 block text-xs text-muted">Root password</Label>
        <div class="relative">
          <Input
            bind:ref={passwordEl}
            type={showPassword ? 'text' : 'password'}
            id="password"
            autocomplete="current-password"
            bind:value={password}
            onkeydown={onKeydown}
            class="pr-9"
          />
          <Button
            variant="ghost"
            size="icon"
            class="text-muted hover:text-foreground absolute top-1/2 right-1.5 h-7 w-7 -translate-y-1/2"
            onclick={() => (showPassword = !showPassword)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
          >
            {#if showPassword}
              <EyeOff class="h-3.5 w-3.5" />
            {:else}
              <Eye class="h-3.5 w-3.5" />
            {/if}
          </Button>
        </div>
        {#if mfaRequired}
          <Label for="mfa-token" class="mt-3.5 mb-1 block text-left text-xs text-muted">Authenticator or recovery code</Label>
          <Input id="mfa-token" autocomplete="one-time-code" inputmode="numeric" bind:value={mfaToken} onkeydown={onKeydown} />
        {/if}
        <Button variant="secondary" class="mt-3.5 w-full" loading={submitting} onclick={submit}>Sign in</Button>
        {#if loginError}
          <div class="mt-2 text-[13px] text-muted">
            {loginError}
            {#if attemptsRemaining !== undefined && attemptsRemaining > 0}
              ({attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} left before a temporary lockout)
            {/if}
          </div>
        {/if}
      </div>
    </details>
    </Card>
  </div>

  <div class="mt-7">
    <LegalLinks />
  </div>
</div>
