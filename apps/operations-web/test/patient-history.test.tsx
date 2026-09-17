import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import page from '../../../packages/contracts/fixtures/history/v1/patient-history-page.json';
import {
  isHistoryPage,
  type HistoryPage,
} from '../../../packages/contracts/src/patient-history.mjs';
import { HistoryCard } from '../src/PatientHistory';
import { createOperationsApi } from '../src/api';
if (!isHistoryPage(page)) throw new Error('Invalid history fixture');
const fixture: HistoryPage = page;
describe('additional patient history', () => {
  it('renders addenda, review resolution, row attribution and explicit source state', () => {
    const html = renderToStaticMarkup(
      <>
        {fixture.items.map((item) => (
          <HistoryCard
            key={item.resourceId}
            item={{
              ...item,
              encounter: {
                ...item.encounter,
                status: 'VOID',
                voidReason: 'Synthetic duplicate',
              },
            }}
          />
        ))}
      </>,
    );
    for (const text of [
      'Synthetic late clarification',
      'Resolved',
      'Position confirmed with the author',
      'Rice',
      'Boiled',
      'Synthetic OTC product',
      'Local pharmacy',
      'Voided encounter',
      'Synthetic Clinic',
      'Synthetic Nurse',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('sourceContentHash');
    expect(html).not.toContain('localResourceId');
  });
  it('escapes recorded text and keeps empty fields distinct from affirmative answers', () => {
    const note = fixture.items[0]!;
    const html = renderToStaticMarkup(
      <HistoryCard
        item={{ ...note, data: { noteText: '<script>synthetic</script>' } }}
      />,
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('uses POST and no-store for dates, patient references and opaque continuations', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const result = await createOperationsApi(
      '',
      'token',
      fetcher,
    ).getPatientHistory({
      contractVersion: '1.0',
      personId: fixture.personId,
      reasonCode: 'CARE_DELIVERY',
      fromDate: fixture.fromDate,
      toDate: fixture.toDate,
    });
    expect(result).toEqual(fixture);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/v1/operations/patients/history',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      cache: 'no-store',
    });
  });
  it('fails closed on malformed nested rows and missing authors', async () => {
    const invalid = structuredClone(fixture) as unknown as {
      items: Record<string, unknown>[];
    };
    delete invalid.items[0]!.author;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(invalid), { status: 200 }),
      );
    await expect(
      createOperationsApi('', 'token', fetcher).getPatientHistory({
        contractVersion: '1.0',
        personId: fixture.personId,
        reasonCode: 'CARE_DELIVERY',
        fromDate: fixture.fromDate,
        toDate: fixture.toDate,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  });
});
