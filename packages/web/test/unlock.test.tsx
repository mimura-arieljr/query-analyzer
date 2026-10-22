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

describe('UnlockGate', () => {
  it('focuses the field when the screen appears', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    expect(document.activeElement).toBe(field());
  });

  it('explains what the secret is and where to find it', () => {
    render(<UnlockGate onUnlock={vi.fn()} />);
    const help = screen.getByText(/where do i find the secret/i).closest('details');
    expect(help).not.toBeNull();
    expect(help?.textContent).toContain('query-analyzer-shared-secret');
    expect(help?.textContent).toContain('Retrieve secret value');
    expect(help?.textContent).toContain('ap-southeast-2');
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
