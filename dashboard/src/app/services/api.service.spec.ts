import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { ApiService, AgentEntry, RunRequest, RunResponse } from './api.service';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [ApiService],
    });
    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should fetch agents', () => {
    const mockAgents: AgentEntry[] = [
      { id: '1', name: 'Agent 1', tag: 'A1', colorCode: 1, category: 'development' },
    ];

    service.getAgents().subscribe(agents => {
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('Agent 1');
    });

    const req = httpMock.expectOne('/api/agents');
    expect(req.request.method).toBe('GET');
    req.flush(mockAgents);
  });

  it('should start a run', () => {
    const mockRequest: RunRequest = {
      systemName: 'Test',
      requirementsText: 'Test requirements',
      mode: 'human',
    };
    const mockResponse: RunResponse = {
      status: 'ok',
      systemName: 'Test',
      mode: 'human',
      threadId: '123',
    };

    service.startRun(mockRequest).subscribe(response => {
      expect(response.status).toBe('ok');
      expect(response.threadId).toBe('123');
    });

    const req = httpMock.expectOne('/api/run');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(mockRequest);
    req.flush(mockResponse);
  });

  it('should get run state', () => {
    service.getRunState('123').subscribe(state => {
      expect(state).toBeTruthy();
    });

    const req = httpMock.expectOne('/api/run/123');
    expect(req.request.method).toBe('GET');
    req.flush({ status: 'running' });
  });

  it('should approve a phase', () => {
    service.approvePhase('123', true, 'Looks good').subscribe(result => {
      expect(result).toBeTruthy();
    });

    const req = httpMock.expectOne('/api/run/123/approve');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ approved: true, feedback: 'Looks good' });
    req.flush({ status: 'approved' });
  });
});
