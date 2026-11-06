import {mountTaskReview} from './coding-task-review.mjs';
// No mock successes, API credentials or local authority fallback.
// Authenticated #32/#40 adapter must supply the current owner/task binding.
mountTaskReview(document.getElementById('review-root'),null);
