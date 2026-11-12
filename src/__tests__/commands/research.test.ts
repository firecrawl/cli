import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleLookupProteinCommand,
  handleSearchPapersCommand,
} from '../../commands/research';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { writeOutput } from '../../utils/output';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/agent-origin', () => ({
  getCliOrigin: () => 'cli.test@1.0.0',
}));

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(() => null),
}));

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('handleSearchPapersCommand', () => {
  const names = Array.from({ length: 16 }, (_, i) => `Author ${i + 1}`);
  const response = {
    results: [
      {
        paperId: 'arxiv:1706.03762',
        primaryId: 'arxiv:1706.03762',
        title: 'Attention Is All You Need',
        abstract: 'We propose a new network architecture.',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        createdDate: '2017-06-12',
        updateDate: '2017-06-12',
      },
      {
        paperId: 'arxiv:2001.00001',
        primaryId: 'arxiv:2001.00001',
        title: 'A long author list',
        abstract: 'Many authors.',
        authors: names,
      },
      {
        paperId: 'arxiv:2001.00002',
        primaryId: 'arxiv:2001.00002',
        title: 'A comma-joined author string',
        abstract: 'Many authors.',
        authors: names.join(', '),
      },
    ],
  };

  const expectRenderedPapers = () => {
    const [content] = vi.mocked(writeOutput).mock.calls[0];
    expect(content).toContain('Authors: Ashish Vaswani; Noam Shazeer');
    expect(content).toContain('Dates: created 2017-06-12; updated 2017-06-12');
    expect(content).toMatch(/Author 15; et al\.\n/);
    expect(content).toMatch(/Author 15; \+1 more\n/);
    expect(content).not.toContain('Author 16');
  };

  beforeEach(() => {
    setupTest();
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends sort and renders authors and dates with an API key', async () => {
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    const mockHttpGet = vi.fn().mockResolvedValue({ data: response });
    vi.mocked(getClient).mockReturnValue({
      http: { get: mockHttpGet },
    } as any);

    await handleSearchPapersCommand({
      query: 'transformer attention',
      sort: 'date_desc',
    });

    expect(mockHttpGet).toHaveBeenCalledWith(
      '/v2/search/research/papers?query=transformer+attention&sort=date_desc&integration=cli&origin=cli.test%401.0.0'
    );
    expectRenderedPapers();
  });

  it('sends sort and renders authors and dates without an API key', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(response), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await handleSearchPapersCommand({
      query: 'transformer attention',
      sort: 'date_desc',
    });

    expect(getClient).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search/research/papers?query=transformer+attention&sort=date_desc&integration=cli&origin=cli.test%401.0.0',
      expect.objectContaining({ method: 'GET' })
    );
    expectRenderedPapers();
  });
});

describe('handleLookupProteinCommand', () => {
  const found = {
    success: true,
    release: '2026_04',
    match: 'found',
    protein: {
      accession: 'Q6P087',
      entryName: 'RUSD3_HUMAN',
      gene: 'RPUSD3',
      synonyms: [],
      name: 'Mitochondrial mRNA pseudouridine synthase RPUSD3',
      organism: {
        taxonId: 9606,
        scientificName: 'Homo sapiens',
        commonName: 'Human',
      },
      matchedBy: 'gene',
      url: 'https://www.uniprot.org/uniprotkb/Q6P087/entry',
      subcellularLocation: [
        {
          text: 'Mitochondrion matrix',
          note: false,
          evidence: [
            {
              kind: 'experimental',
              eco: 'ECO:0000269',
              paperId: 'pmid:27974379',
            },
          ],
        },
        {
          text: 'Localizes to mitochondrial RNA granules, platforms for post-transcriptional RNA modification and ribosome assembly',
          note: true,
          evidence: [
            {
              kind: 'experimental',
              eco: 'ECO:0000269',
              paperId: 'pmid:27974379',
            },
            {
              kind: 'experimental',
              eco: 'ECO:0000269',
              paperId: 'pmid:28082677',
            },
          ],
        },
      ],
      function: [
        {
          text: 'Catalyzes uridine to pseudouridine isomerization (pseudouridylation) of specific mitochondrial mRNAs (mt-mRNAs), a post-transcriptional modification necessary for their translation. Acts at position 390 in COXI mt-mRNA and at position 697-699 in mitochondrial COXIII mt-mRNA (PubMed:27974379). As a component of a functional protein-RNA module, consisting of RCC1L, NGRN, RPUSD3, RPUSD4, TRUB2, FASTKD2 and 16S mitochondrial ribosomal RNA (16S mt-rRNA), controls 16S mt-rRNA abundance and may play a role in mitochondrial ribosome biogenesis (PubMed:27667664)',
          note: false,
          evidence: [
            {
              kind: 'experimental',
              eco: 'ECO:0000269',
              paperId: 'pmid:27667664',
            },
            {
              kind: 'experimental',
              eco: 'ECO:0000269',
              paperId: 'pmid:27974379',
            },
          ],
        },
      ],
      goCellularComponent: [
        {
          id: 'GO:0005759',
          term: 'mitochondrial matrix',
          code: 'IDA',
          assignedBy: 'FlyBase',
          paperIds: ['pmid:27974379'],
        },
        {
          id: 'GO:0005739',
          term: 'mitochondrion',
          code: 'IDA',
          assignedBy: 'FlyBase',
          paperIds: ['pmid:28082677'],
        },
        {
          id: 'GO:0035770',
          term: 'ribonucleoprotein granule',
          code: 'IDA',
          assignedBy: 'FlyBase',
          paperIds: ['pmid:28082677'],
        },
      ],
      paperIds: ['pmid:27974379', 'pmid:28082677', 'pmid:27667664'],
    },
    notice:
      'Protein data from UniProtKB/Swiss-Prot release 2026_04. Copyright UniProt Consortium, https://www.uniprot.org. CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. No warranty, see https://www.uniprot.org/help/license. Selected fields, reformatted.',
  };

  beforeEach(() => {
    setupTest();
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends protein and organism and prints the found entry with an API key', async () => {
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    const mockHttpGet = vi.fn().mockResolvedValue({ data: found });
    vi.mocked(getClient).mockReturnValue({
      http: { get: mockHttpGet },
    } as any);

    await handleLookupProteinCommand({
      protein: 'RPUSD3',
      organism: 'Homo sapiens',
    });

    expect(mockHttpGet).toHaveBeenCalledWith(
      '/v2/search/research/proteins?protein=RPUSD3&organism=Homo+sapiens&integration=cli&origin=cli.test%401.0.0'
    );
    expect(vi.mocked(writeOutput).mock.calls[0][0]).toBe(
      [
        '# RPUSD3 (Q6P087, RUSD3_HUMAN), Homo sapiens',
        'Mitochondrial mRNA pseudouridine synthase RPUSD3. Matched by gene symbol.',
        '',
        'Subcellular location',
        '- Mitochondrion matrix. Experimental [pmid:27974379]',
        '- Note: Localizes to mitochondrial RNA granules, platforms for post-transcriptional RNA modification and ribosome assembly. Experimental [pmid:27974379, pmid:28082677]',
        'GO cellular component (experimental)',
        '- mitochondrial matrix (GO:0005759), IDA, FlyBase [pmid:27974379]',
        '- mitochondrion (GO:0005739), IDA, FlyBase [pmid:28082677]',
        '- ribonucleoprotein granule (GO:0035770), IDA, FlyBase [pmid:28082677]',
        'Function',
        `- ${found.protein.function[0].text}. Experimental [pmid:27667664, pmid:27974379]`,
        'Open a cited paper with `firecrawl research inspect-paper <paperId>` or `firecrawl research read-paper <paperId> --question <question>`.',
        'Source: UniProtKB/Swiss-Prot 2026_04, https://www.uniprot.org/uniprotkb/Q6P087/entry. CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.',
      ].join('\n')
    );
  });

  it('lists candidates for an ambiguous protein without an API key', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
    const ambiguous = {
      success: true,
      release: '2026_04',
      match: 'ambiguous',
      candidates: [
        {
          accession: 'P05771',
          entryName: 'KPCB_HUMAN',
          gene: 'PRKCB',
          name: 'Protein kinase C beta type',
          organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
          matchedBy: 'name',
        },
      ],
      candidateCount: 12,
      notice: found.notice,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(ambiguous), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await handleLookupProteinCommand({ protein: 'kinase' });

    expect(getClient).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search/research/proteins?protein=kinase&integration=cli&origin=cli.test%401.0.0',
      expect.objectContaining({ method: 'GET' })
    );
    expect(vi.mocked(writeOutput).mock.calls[0][0]).toBe(
      [
        '"kinase" does not resolve to one UniProtKB/Swiss-Prot entry in the requested organism (human unless --organism is set). 12 candidates, the first 1 listed, as accession, entry name, gene, name, organism:',
        '- P05771, KPCB_HUMAN, PRKCB, Protein kinase C beta type, Homo sapiens',
        'Run `firecrawl research lookup-protein` again with one accession.',
        'Source: UniProtKB/Swiss-Prot 2026_04. CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.',
      ].join('\n')
    );
  });

  it('prints the API error for a refused organism with an API key', async () => {
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    const error =
      "unknown organism 'Martian': pass an NCBI taxon ID such as 9606, a scientific name such as Homo sapiens, or a UniProt common name such as Human";
    vi.mocked(getClient).mockReturnValue({
      http: {
        get: vi.fn().mockRejectedValue({
          response: { status: 400, data: { success: false, error } },
        }),
      },
    } as any);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    await handleLookupProteinCommand({
      protein: 'RPUSD3',
      organism: 'Martian',
    });

    expect(consoleError).toHaveBeenCalledWith('Error:', error);
    expect(exit).toHaveBeenCalledWith(1);
    expect(writeOutput).not.toHaveBeenCalled();
  });
});
