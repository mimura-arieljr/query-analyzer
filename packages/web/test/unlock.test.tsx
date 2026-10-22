import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSecret } from '../src/api';
import { UnlockGate } from '../src/UnlockGate';

vi.mock('../src/api', () => ({
  checkSecret: vi.fn(),
  analyze: vi.fn(),
  sha256Hex: vi.fn(),
}));

function field(): HTMLInputElement {
  return screen.getByLabelText('Secret') as HTMLInputElement;
}

function type(value: string) {
  fireEvent.change(field(), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /^(Unlock|Checking)/ }));
}

beforeEach(() => {
  vi.mocked(checkSecret).mockReset();
});

afterEach(() => {
  cleanup();
});

const HELP = 'Where do I find it?';

function helpButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: HELP }) as HTMLButtonElement;
}

describe('the help popover', () => {
  it('starts closed, with an info button that says so', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(helpButton().getAttribute('aria-expanded')).toBe('false');
    expect(helpButton().getAttribute('aria-controls')).toBe('secret-help');
    expect(helpButton().getAttribute('type')).toBe('button');
    expect(screen.queryByText(/Retrieve secret value/)).toBeNull();
  });

  it('draws the info icon as a decorative graphic', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    const icon = helpButton().querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens on click with generic steps that fit any region and secret name', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    fireEvent.click(helpButton());
    expect(helpButton().getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById('secret-help');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(text).toContain('Secrets Manager');
    expect(text).toContain('Retrieve secret value');
    expect(text).toContain('region you deployed');
    expect(text).toContain('SecretName');
    expect(text).toContain('Never paste');
    expect(text).not.toContain('ap-southeast-2');
    expect(text).not.toContain('query-analyzer-shared-secret');
  });

  it('closes when the button is pressed again', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    fireEvent.click(helpButton());
    fireEvent.click(helpButton());
    expect(helpButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('secret-help')).toBeNull();
  });

  it('closes on Escape and puts the focus back on the button', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    fireEvent.click(helpButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('secret-help')).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });

  it('closes when the user clicks somewhere else, but not inside the panel', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    fireEvent.click(helpButton());
    fireEvent.mouseDown(document.getElementById('secret-help') as HTMLElement);
    expect(document.getElementById('secret-help')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(document.getElementById('secret-help')).toBeNull();
  });

  it('does not take the secret label, so the field keeps a single label', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(screen.getAllByLabelText(/secret/i)).toHaveLength(1);
    fireEvent.click(helpButton());
    expect(screen.getAllByLabelText(/secret/i)).toHaveLength(1);
  });
});

describe('the unlock card layout', () => {
  it('puts the app name at the top of the card, once', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    const card = document.querySelector('form.unlock') as HTMLElement;
    const title = screen.getByRole('heading', { name: 'Query Analyzer' });
    expect(card.contains(title)).toBe(true);
    expect(card.firstElementChild?.contains(title)).toBe(true);
    expect(screen.getAllByRole('heading', { name: 'Query Analyzer' })).toHaveLength(1);
  });

  it('shows Show and Unlock as icon-only buttons inside the field, side by side', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    const show = screen.getByRole('button', { name: 'Show' });
    const unlock = screen.getByRole('button', { name: 'Unlock' });
    expect(show.textContent).toBe('');
    expect(unlock.textContent).toBe('');
    expect(show.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(unlock.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(unlock.getAttribute('type')).toBe('submit');
    expect(show.parentElement).toBe(unlock.parentElement);
    expect(show.closest('.secret-field')).toBe(field().parentElement);
  });

  it('swaps the Unlock icon for a busy state while checking', () => {
    vi.mocked(checkSecret).mockReturnValue(new Promise(() => {}));
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('pw');
    submit();
    const busy = screen.getByRole('button', { name: 'Checking...' });
    expect(busy.querySelector('svg')?.getAttribute('class')).toBe('spin');
  });
});

describe('UnlockGate', () => {
  it('focuses the field when the screen appears', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(document.activeElement).toBe(field());
  });

  it('shows the characters only after the Show button is pressed', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(field().type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(field().type).toBe('text');
    const hide = screen.getByRole('button', { name: 'Hide' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(field().type).toBe('password');
  });

  it('keeps the Show button out of the way of the Unlock button on Enter', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Show' }).getAttribute('type')).toBe('button');
  });

  it('turns off autofill, autocorrect and capitalization on the field', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(field().getAttribute('autocomplete')).toBe('new-password');
    expect(field().getAttribute('autocapitalize')).toBe('off');
    expect(field().getAttribute('autocorrect')).toBe('off');
    expect(field().getAttribute('spellcheck')).toBe('false');
  });

  it('asks for the secret without calling the server when the field is empty', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    submit();
    expect(screen.getByRole('alert').textContent).toBe('Paste the secret first.');
    expect(checkSecret).not.toHaveBeenCalled();
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });

  it('checks the secret with the whitespace around it removed', async () => {
    vi.mocked(checkSecret).mockResolvedValue('ok');
    const onUnlock = vi.fn();
    render(<UnlockGate onUnlock={onUnlock} />);
    type('  pw-123 \n');
    submit();
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('pw-123'));
    expect(checkSecret).toHaveBeenCalledWith('pw-123');
  });

  it('treats a secret that is only whitespace as empty', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('   \n ');
    submit();
    expect(screen.getByRole('alert').textContent).toBe('Paste the secret first.');
    expect(checkSecret).not.toHaveBeenCalled();
  });

  it('marks the field invalid and puts the cursor back in it after a wrong secret', async () => {
    vi.mocked(checkSecret).mockResolvedValue('wrong');
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('nope');
    (screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement).focus();
    submit();
    expect(await screen.findByText('Wrong or missing secret.')).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it('says it could not reach the server instead of calling the secret wrong', async () => {
    vi.mocked(checkSecret).mockResolvedValue('error');
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('pw');
    submit();
    expect(await screen.findByText("Couldn't reach the server. Try again.")).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('clears the error and the invalid mark as soon as the user types again', async () => {
    vi.mocked(checkSecret).mockResolvedValue('wrong');
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('nope');
    submit();
    await screen.findByText('Wrong or missing secret.');
    type('nope2');
    expect(screen.queryByText('Wrong or missing secret.')).toBeNull();
    expect(field().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('says Checking while it waits and ignores a second submit', async () => {
    let resolve: (v: 'ok') => void = () => {};
    vi.mocked(checkSecret).mockReturnValue(new Promise((r) => (resolve = r)));
    const onUnlock = vi.fn();
    render(<UnlockGate onUnlock={onUnlock} />);
    type('pw');
    submit();
    const busy = screen.getByRole('button', { name: /checking/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.submit(busy.closest('form') as HTMLFormElement);
    expect(checkSecret).toHaveBeenCalledTimes(1);
    resolve('ok');
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('pw'));
  });

  it('shows the notice it is given, for example after the server rejected the secret', () => {
    render(<UnlockGate onUnlock={vi.fn()} notice="Wrong or missing secret." />);
    expect(screen.getByRole('alert').textContent).toBe('Wrong or missing secret.');
  });

  it('never writes the secret to browser storage', async () => {
    vi.mocked(checkSecret).mockResolvedValue('ok');
    const local = vi.spyOn(Storage.prototype, 'setItem');
    render(<UnlockGate onUnlock={vi.fn()} />);
    type('pw');
    submit();
    await waitFor(() => expect(checkSecret).toHaveBeenCalled());
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });
});
