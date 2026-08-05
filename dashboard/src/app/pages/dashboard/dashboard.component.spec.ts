import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const apiSpy = jasmine.createSpyObj('ApiService', ['getAgents', 'connectWebSocket']);
    apiSpy.getAgents.and.returnValue(of([]));
    apiSpy.connectWebSocket.and.returnValue(of());

    await TestBed.configureTestingModule({
      imports: [DashboardComponent, RouterTestingModule, HttpClientTestingModule],
      providers: [{ provide: ApiService, useValue: apiSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should fetch agents on init', () => {
    expect(apiService.getAgents).toHaveBeenCalled();
  });

  it('should connect to websocket on init', () => {
    expect(apiService.connectWebSocket).toHaveBeenCalled();
  });

  it('should return correct color from getColor', () => {
    const color = component.getColor(5);
    expect(color).toContain('hsl(');
  });

  it('should return correct category color', () => {
    expect(component.categoryColor('management')).toBe('purple');
    expect(component.categoryColor('development')).toBe('blue');
    expect(component.categoryColor('quality')).toBe('yellow');
    expect(component.categoryColor('operations')).toBe('green');
    expect(component.categoryColor('unknown')).toBe('blue');
  });
});
