import { Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { NewRunComponent } from './pages/new-run/new-run.component';
import { RunSessionComponent } from './pages/run-session/run-session.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'new-run', component: NewRunComponent },
  { path: 'run/:id', component: RunSessionComponent },
  { path: '**', redirectTo: '' },
];
