import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { NewRunComponent } from './new-run.component';
import { ApiService } from '../../services/api.service';
import { of, throwError } from 'rxjs';

describe('NewRunComponent', () => {
  let component: NewRunComponent;
  let fixture: ComponentFixture<NewRunComponent>;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const apiSpy = jasmine.createSpyObj('ApiService', ['startRun']);

    await TestBed.configureTestingModule({
      imports: [NewRunComponent, FormsModule, HttpClientTestingModule, RouterTestingModule],
      providers: [{ provide: ApiService, useValue: apiSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(NewRunComponent);
    component = fixture.componentInstance;
    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have default values', () => {
    expect(component.mode).toBe('human');
    expect(component.runType).toBe('greenfield');
    expect(component.repoTargetType).toBe('same-repo');
    expect(component.repoIsPrivate).toBeTrue();
    expect(component.loading).toBeFalse();
    expect(component.success).toBeFalse();
  });

  it('should call api.startRun on startRun()', () => {
    apiService.startRun.and.returnValue(of({ status: 'ok', systemName: 'Test', mode: 'human' }));
    component.systemName = 'Test';
    component.requirements = 'Test requirements';
    component.startRun();
    expect(apiService.startRun).toHaveBeenCalled();
  });

  it('should set success on successful run', () => {
    apiService.startRun.and.returnValue(of({ status: 'ok', systemName: 'Test', mode: 'human', threadId: '123' }));
    component.systemName = 'Test';
    component.requirements = 'Test requirements';
    component.startRun();
    expect(component.success).toBeTrue();
    expect(component.threadId).toBe('123');
  });

  it('should set error on failed run', () => {
    apiService.startRun.and.returnValue(throwError(() => ({ error: { error: 'Something failed' } })));
    component.systemName = 'Test';
    component.requirements = 'Test requirements';
    component.startRun();
    expect(component.error).toBe('Something failed');
  });
});
