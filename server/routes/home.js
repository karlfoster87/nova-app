// The Home dashboard (home/home.js): one summary of every card this profile may see. Home has
// no access level of its own; each card follows the access of the view it draws on, and its
// quick actions use those views' own routes.
import { homeSummary } from '../home/home.js';

export default function homeRoutes(api) {
  api.get('/api/home', ({ url, profile }) => homeSummary(profile, url.searchParams.get('today'), url.searchParams.get('tz')));
}
