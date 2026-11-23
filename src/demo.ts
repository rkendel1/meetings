import demo from "../demo.json";

/**
 * Demo mode (demo.json "personas"): a visitor lands on Home already signed in as one of three shared personas, so
 * "Start a meeting now" is the first thing they see. Production has no development sign-in, so the personas are
 * ordinary built-in accounts (auth.accounts) the first visitor creates and everyone after signs in to. Their
 * password is public by design: never use demo mode for anything but a throwaway demo.
 */
export const DEMO = demo.personas === true;

export const PERSONAS = [
  { id: "ada", name: "Ada Lovelace" },
  { id: "grace", name: "Grace Hopper" },
  { id: "alan", name: "Alan Turing" },
] as const;

const KEY = "demo:persona";
const credentials = (id: string) => ({ email: `${id}@demo.example`, password: `demo-${id}-meetings` });

/** The persona this browser used last, else one chosen at random (so two visitors rarely share one). */
export function chosenPersona(): (typeof PERSONAS)[number] {
  try {
    const saved = PERSONAS.find((p) => p.id === localStorage.getItem(KEY));
    if (saved) return saved;
  } catch {
    /* storage blocked: choose again each visit */
  }
  return PERSONAS[Math.floor(Math.random() * PERSONAS.length)]!;
}

type Auth = {
  signIn: (input: { email: string; password: string }) => Promise<unknown>;
  signUp: (input: { email: string; password: string; name?: string }) => Promise<unknown>;
};

/** Sign in as a persona, creating its account the first time anyone does. */
export async function signInAsPersona(auth: Auth, id: string): Promise<void> {
  const persona = PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
  const c = credentials(persona.id);
  try {
    await auth.signIn(c);
  } catch {
    try {
      await auth.signUp({ ...c, name: persona.name });
    } catch {
      await auth.signIn(c); // someone created it a moment ago
    }
  }
  try {
    localStorage.setItem(KEY, persona.id);
  } catch {
    /* ignore */
  }
}
