import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorCode, FinalAnalysis, FinalFinding } from '@qa/core/types';
import { analyze, checkSecret } from '../src/api';
import { App } from '../src/App';
import { ResultView } from '../src/ResultView';

vi.mock('../src/api', () => ({
  checkSecret: vi.fn(),
  analyze: vi.fn(),
  sha256Hex: vi.fn(),
}));

const FORM_LABEL = 'Paste a database or log query';

function finding(over: Partial<FinalFinding> = {}): FinalFinding {
  return {
    reason: 'A reason',
    certainty: 'certain',
    assumption: '',
    how_to_verify: '',
    source: 'ai',
    ...over,
  };
}

function makeAnalysis(over: Partial<FinalAnalysis> = {}): FinalAnalysis {
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'postgresql', dialect_note: '', confidence: 'high' },
    what_it_does: 'Reads all users.',
    detailed_explanation: 'The database scans the users table.',
    simple_explanation: 'Lists everyone.',
    step_by_step: [{ snippet: 'SELECT *', explanation: 'Picks all columns.' }],
    improvements: [],
    rewritten_query: { query: '', reason: '' },
    security: { level: 'none', findings: [] },
    danger: {
      level: 'none',
      findings: [],
      can_change_data: 'no',
      data_change_summary: '',
    },
    performance: { level: 'none', findings: [] },
    ...over,
  };
}

async function unlock() {
  vi.mocked(checkSecret).mockResolvedValue('ok');
  const view = render(<App />);
  fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await screen.findByLabelText(FORM_LABEL);
  return view;
}

function analyzeText(text: string) {
  fireEvent.change(screen.getByLabelText(FORM_LABEL), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
}

beforeEach(() => {
  vi.mocked(checkSecret).mockReset();
  vi.mocked(analyze).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('unlock', () => {
  it('centres the unlock card with a gate layout, and drops it once unlocked', async () => {
    vi.mocked(checkSecret).mockResolvedValue('ok');
    const { container } = render(<App />);
    expect(container.querySelector('.wrap')?.classList.contains('wrap-gate')).toBe(true);
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByLabelText(FORM_LABEL);
    expect(container.querySelector('.wrap')?.classList.contains('wrap-gate')).toBe(false);
  });

  it('shows the unlock box first and a wrong secret shows the message', async () => {
    vi.mocked(checkSecret).mockResolvedValue('wrong');
    render(<App />);
    expect(screen.queryByLabelText(FORM_LABEL)).toBeNull();
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Wrong or missing secret.')).toBeTruthy();
    expect(screen.queryByLabelText(FORM_LABEL)).toBeNull();
  });

  it('a right secret reveals the form', async () => {
    await unlock();
    expect(checkSecret).toHaveBeenCalledWith('pw');
    expect(screen.getByRole('heading', { name: 'Query Analyzer' })).toBeTruthy();
    expect(
      screen.getByText(
        'Tested on PostgreSQL, MySQL and CloudWatch Logs Insights. Anything else is explained on a best-effort basis, with lower confidence.',
      ),
    ).toBeTruthy();
    const box = screen.getByLabelText(FORM_LABEL);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
  });

  it('says so when the server cannot be reached', async () => {
    vi.mocked(checkSecret).mockResolvedValue('error');
    render(<App />);
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText("Couldn't reach the server. Try again.")).toBeTruthy();
  });
});

describe('QueryForm', () => {
  it('Analyze is disabled for empty text and for 20001 characters', async () => {
    await unlock();
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' }) as HTMLButtonElement;
    const box = screen.getByLabelText(FORM_LABEL);
    expect(analyzeBtn.disabled).toBe(true);
    expect(screen.getByText('0 / 20,000 characters')).toBeTruthy();

    fireEvent.change(box, { target: { value: 'select 1' } });
    expect(analyzeBtn.disabled).toBe(false);

    fireEvent.change(box, { target: { value: 'a'.repeat(20000) } });
    expect(analyzeBtn.disabled).toBe(false);
    expect(screen.getByText('20,000 / 20,000 characters')).toBeTruthy();

    fireEvent.change(box, { target: { value: 'a'.repeat(20001) } });
    expect(analyzeBtn.disabled).toBe(true);
    expect(screen.getByText('20,001 / 20,000 characters')).toBeTruthy();
  });

  it('Clear empties the text and the result', async () => {
    vi.mocked(analyze).mockResolvedValue({ ok: true, analysis: makeAnalysis() });
    await unlock();
    analyzeText('select * from users');
    await screen.findByText('Reads all users.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((screen.getByLabelText(FORM_LABEL) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('Reads all users.')).toBeNull();
  });
});

describe('ResultView', () => {
  it('renders the danger banner above the cards', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          danger: {
            level: 'high',
            findings: [finding({ reason: 'Updates every row' })],
            can_change_data: 'yes',
            data_change_summary: 'it sets every user to inactive',
          },
        })}
      />,
    );
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('Danger: high');
    expect(banner.textContent).toContain(
      'This query changes data: it sets every user to inactive',
    );
    for (const name of ['What it does', 'Step by step', 'Security', 'Danger', 'Performance']) {
      const heading = screen.getByRole('heading', { name });
      expect(
        banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const dangerCard = screen.getByRole('heading', { name: 'Danger' }).closest('.card') as HTMLElement;
    expect(within(dangerCard).getByText('High')).toBeTruthy();
  });

  it('words the banner for read-only and unclear queries', () => {
    const { unmount } = render(<ResultView analysis={makeAnalysis()} />);
    expect(screen.getByRole('alert').textContent).toContain('This query only reads data.');
    unmount();
    render(
      <ResultView
        analysis={makeAnalysis({
          danger: {
            level: 'medium',
            findings: [],
            can_change_data: 'unclear',
            data_change_summary: 'it calls a procedure',
          },
        })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Unclear whether this query changes data: it calls a procedure',
    );
  });

  it('keeps "only reads data" for can_change_data no at level none', () => {
    render(<ResultView analysis={makeAnalysis()} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('Danger: none');
    expect(text).toContain('This query only reads data.');
  });

  it('does not say "only reads data" under a danger level above none', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          danger: {
            level: 'high',
            findings: [finding({ reason: 'This GRANT statement changes who is allowed to access the database.' })],
            can_change_data: 'no',
            data_change_summary: '',
          },
        })}
      />,
    );
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('Danger: high');
    expect(text).toContain('This query does not change table rows, but see the danger findings below.');
    expect(text).not.toContain('only reads data');
  });

  it('shows language and confidence chips, the dialect note and the detailed text', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          query_type: {
            language: 'cloudwatch_logs_insights',
            dialect_note: 'Uses the stats command.',
            confidence: 'medium',
          },
        })}
      />,
    );
    expect(screen.getByText('CloudWatch Logs Insights')).toBeTruthy();
    expect(screen.getByText('Confidence: medium')).toBeTruthy();
    expect(screen.getByText('Uses the stats command.')).toBeTruthy();
    const details = screen.getByText('The database scans the users table.').closest('details');
    expect(details).not.toBeNull();
  });

  it('shows certain and possible findings with different labels', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          performance: {
            level: 'medium',
            findings: [
              finding({ reason: 'Sure thing', certainty: 'certain' }),
              finding({
                reason: 'Maybe thing',
                certainty: 'possible',
                assumption: 'the table is big',
                how_to_verify: 'run a count',
              }),
            ],
          },
        })}
      />,
    );
    const certain = screen.getByText('Sure thing').closest('.finding') as HTMLElement;
    const possible = screen.getByText('Maybe thing').closest('.finding') as HTMLElement;
    expect(certain.classList.contains('certain')).toBe(true);
    expect(within(certain).getByText('Certain')).toBeTruthy();
    expect(within(certain).queryByText('Assumed:')).toBeNull();
    expect(possible.classList.contains('possible')).toBe(true);
    expect(within(possible).getByText('Possible')).toBeTruthy();
    expect(within(possible).getByText('Assumed:')).toBeTruthy();
    expect(within(possible).getByText('the table is big')).toBeTruthy();
    expect(within(possible).getByText('Check it:')).toBeTruthy();
    expect(within(possible).getByText('run a count')).toBeTruthy();
  });

  it('shows the Rule check and AI tags', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          security: {
            level: 'high',
            findings: [
              finding({ reason: 'From rules', source: 'rule', ruleId: 'sql-injection' }),
              finding({ reason: 'From model', source: 'ai' }),
            ],
          },
        })}
      />,
    );
    const fromRules = screen.getByText('From rules').closest('.finding') as HTMLElement;
    const fromModel = screen.getByText('From model').closest('.finding') as HTMLElement;
    expect(within(fromRules).getByText('Rule check')).toBeTruthy();
    expect(within(fromRules).queryByText('AI')).toBeNull();
    expect(within(fromModel).getByText('AI')).toBeTruthy();
    expect(within(fromModel).queryByText('Rule check')).toBeNull();
  });

  it('shows "No specific issue listed" for a level without findings', () => {
    render(
      <ResultView
        analysis={makeAnalysis({ security: { level: 'medium', findings: [] } })}
      />,
    );
    const card = screen.getByRole('heading', { name: 'Security' }).closest('.card') as HTMLElement;
    expect(within(card).getByText('Medium')).toBeTruthy();
    expect(within(card).getByText('No specific issue listed')).toBeTruthy();
    const quiet = screen.getByRole('heading', { name: 'Performance' }).closest('.card') as HTMLElement;
    expect(within(quiet).queryByText('No specific issue listed')).toBeNull();
    expect(within(quiet).getByText('No findings.')).toBeTruthy();
  });

  it('hides the rewrite card when the rewrite is empty and shows Copy when present', async () => {
    const { unmount } = render(<ResultView analysis={makeAnalysis()} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Rewritten query' })).toBeNull();
    unmount();

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(
      <ResultView
        analysis={makeAnalysis({
          rewritten_query: { query: 'SELECT id FROM users', reason: 'Fewer columns.' },
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Rewritten query' })).toBeTruthy();
    expect(screen.getByText('Fewer columns.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('SELECT id FROM users');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('does not throw when the clipboard API is missing', async () => {
    vi.stubGlobal('navigator', {});
    render(
      <ResultView
        analysis={makeAnalysis({ rewritten_query: { query: 'SELECT 1', reason: 'r' } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText("Couldn't copy")).toBeTruthy();
  });

  it('non-query result shows only the message', () => {
    render(
      <ResultView
        analysis={makeAnalysis({
          is_query: false,
          not_a_query_message: 'That looks like a recipe, not a query.',
        })}
      />,
    );
    expect(screen.getByText('That looks like a recipe, not a query.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Security' })).toBeNull();
    expect(screen.queryByText('Reads all users.')).toBeNull();
  });

  it('renders model text as plain text, not HTML', () => {
    render(
      <ResultView
        analysis={makeAnalysis({ what_it_does: '<img src=x onerror=alert(1)> done' })}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> done')).toBeTruthy();
  });
});

describe('errors', () => {
  it('each error code shows its fixed message', async () => {
    const cases: [ErrorCode, string][] = [
      ['too_long', 'Too long (limit 20,000 characters).'],
      ['bad_output', "Couldn't analyse that. Try again."],
      ['failed', "Couldn't analyse that. Try again."],
      ['throttled', 'Too many requests. Wait a moment and try again.'],
      ['empty', 'Paste a query to analyze.'],
      ['bad_request', 'That request was not valid.'],
    ];
    for (const [error, message] of cases) {
      vi.mocked(analyze).mockResolvedValue({ ok: false, error, message: 'server words' });
      const view = await unlock();
      analyzeText('select 1');
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText('server words')).toBeNull();
      view.unmount();
    }
  });

  it('unauthorized sends the user back to the unlock box', async () => {
    vi.mocked(analyze).mockResolvedValue({
      ok: false,
      error: 'unauthorized',
      message: 'nope',
    });
    await unlock();
    analyzeText('select 1');
    expect(await screen.findByText('Wrong or missing secret.')).toBeTruthy();
    expect(screen.queryByLabelText(FORM_LABEL)).toBeNull();
    expect(screen.getByLabelText(/secret/i)).toBeTruthy();
  });
});

describe('storage and theme', () => {
  it('never calls localStorage.setItem', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(analyze).mockResolvedValue({ ok: true, analysis: makeAnalysis() });
    await unlock();
    analyzeText('select 1');
    await screen.findByText('Reads all users.');
    fireEvent.click(screen.getByRole('button', { name: /mode/i }));
    expect(setItem).not.toHaveBeenCalled();
  });

  it('theme toggle switches data-theme', async () => {
    render(<App />);
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light mode' }));
    await waitFor(() => expect(root.getAttribute('data-theme')).toBe('light'));
    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }));
    await waitFor(() => expect(root.getAttribute('data-theme')).toBe('dark'));
  });
});
