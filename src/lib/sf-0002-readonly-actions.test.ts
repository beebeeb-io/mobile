// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
/**
 * SF-0002 M2a run 3: the app-side write and share gates, one test per row of
 * the contract's decision table and per surface that reads it.
 *
 * The gate functions are pure: the screens resolve the name convention and
 * classify the content version first, then ask these functions what to offer.
 * `unknown` never writes and never shares; an UpperRepair content allows a
 * rename but coerces every write into a copy.
 */
import { expect, test } from 'bun:test';
import {
  OWNER_CHECK_FAILED_COPY,
  READ_ONLY_EDIT_COPY,
  READ_ONLY_SHARE_COPY,
  editorSavePlan,
  folderSharePlan,
  legacyMovePlan,
  renameOffer,
  singleFileSharePlan,
  uploadConflictPlan,
} from './sf-0002-readonly-actions';

// ── Rename: name String or Binary (incl. string_or_binary), never UpperRepair
// ── or unresolved. Content UpperRepair does NOT hide rename (refinement (a)).

test('rename_is_offered_for_a_string_name', () => {
  expect(renameOffer('string', 'string')).toBe('rename');
});

test('rename_is_offered_for_a_binary_name', () => {
  expect(renameOffer('binary', 'binary')).toBe('rename');
});

test('rename_is_offered_for_a_string_or_binary_name', () => {
  expect(renameOffer('string_or_binary', 'string_or_binary')).toBe('rename');
});

test('rename_is_offered_for_a_string_name_with_upper_repair_content', () => {
  // Refinement (a): the name is fine; only the CONTENT is old-convention.
  expect(renameOffer('string', 'upper_repair')).toBe('rename');
});

test('rename_is_not_offered_for_an_upper_repair_name', () => {
  expect(renameOffer('upper_repair', 'upper_repair')).toBe('no-rename');
});

test('rename_is_not_offered_when_the_name_is_unresolved', () => {
  expect(renameOffer(null, 'unknown')).toBe('no-rename');
  expect(renameOffer(undefined, 'unknown')).toBe('no-rename');
});

// ── Overwrite / new version / upload conflict sheet ──────────────────────────

test('a_known_row_keeps_the_ordinary_overwrite_prompt', () => {
  expect(uploadConflictPlan('string', 'string')).toEqual({ action: 'ask' });
  expect(uploadConflictPlan('string_or_binary', 'binary')).toEqual({ action: 'ask' });
});

test('an_upper_repair_content_coerces_the_conflict_sheet_to_keep_both', () => {
  expect(uploadConflictPlan('string', 'upper_repair')).toEqual({
    action: 'keep-both',
    copy: READ_ONLY_EDIT_COPY,
  });
});

test('an_upper_repair_name_coerces_the_conflict_sheet_to_keep_both', () => {
  expect(uploadConflictPlan('upper_repair', 'unknown')).toEqual({
    action: 'keep-both',
    copy: READ_ONLY_EDIT_COPY,
  });
});

test('an_unclassified_content_shows_the_network_copy_and_uploads_nothing', () => {
  const plan = uploadConflictPlan('string', 'unknown');
  expect(plan).toEqual({ action: 'retry', copy: OWNER_CHECK_FAILED_COPY });
  // A retry plan never reaches an upload.
  let uploads = 0;
  const runSurface = (p: { action: string }) => { if (p.action === 'ask' || p.action === 'keep-both') uploads += 1; };
  runSurface(plan);
  expect(uploads).toBe(0);
});

test('a_failed_name_classification_shows_the_network_copy_and_uploads_nothing', () => {
  const plan = uploadConflictPlan(null, 'unknown');
  expect(plan).toEqual({ action: 'retry', copy: OWNER_CHECK_FAILED_COPY });
});

// ── Editor save ──────────────────────────────────────────────────────────────

test('the_editor_button_reads_save_as_a_copy_for_upper_repair_content', () => {
  expect(editorSavePlan('string', 'upper_repair')).toEqual({
    action: 'save-copy',
    label: 'Save as a copy',
    copy: READ_ONLY_EDIT_COPY,
  });
});

test('the_editor_refuses_to_edit_an_upper_repair_name', () => {
  expect(editorSavePlan('upper_repair', 'unknown')).toEqual({
    action: 'retry',
    copy: READ_ONLY_EDIT_COPY,
    retry: false,
  });
});

test('the_editor_shows_the_network_copy_when_classification_fails', () => {
  expect(editorSavePlan('string', 'unknown')).toEqual({
    action: 'retry',
    copy: OWNER_CHECK_FAILED_COPY,
    retry: true,
  });
});

test('the_editor_saves_in_place_when_both_halves_are_writable', () => {
  expect(editorSavePlan('string', 'string')).toEqual({ action: 'save', label: 'Save' });
});

// ── Single-file share ────────────────────────────────────────────────────────

test('a_string_named_string_file_can_be_shared', () => {
  expect(singleFileSharePlan('string', 'string')).toEqual({ allowed: true });
});

test('a_string_named_binary_file_can_be_shared', () => {
  expect(singleFileSharePlan('string', 'binary')).toEqual({ allowed: true });
});

test('an_upper_repair_content_is_refused_with_the_share_copy', () => {
  expect(singleFileSharePlan('string', 'upper_repair')).toEqual({
    allowed: false,
    copy: READ_ONLY_SHARE_COPY,
    retry: false,
  });
});

test('a_binary_or_ambiguous_name_is_refused_with_the_share_copy', () => {
  expect(singleFileSharePlan('binary', 'binary')).toEqual({
    allowed: false,
    copy: READ_ONLY_SHARE_COPY,
    retry: false,
  });
  expect(singleFileSharePlan('string_or_binary', 'string')).toEqual({
    allowed: false,
    copy: READ_ONLY_SHARE_COPY,
    retry: false,
  });
  expect(singleFileSharePlan('upper_repair', 'unknown')).toEqual({
    allowed: false,
    copy: READ_ONLY_SHARE_COPY,
    retry: false,
  });
});

test('an_unclassified_content_is_refused_with_the_network_copy', () => {
  expect(singleFileSharePlan('string', 'unknown')).toEqual({
    allowed: false,
    copy: OWNER_CHECK_FAILED_COPY,
    retry: true,
  });
});

test('an_unresolved_name_is_refused_with_the_network_copy', () => {
  expect(singleFileSharePlan(null, 'string')).toEqual({
    allowed: false,
    copy: OWNER_CHECK_FAILED_COPY,
    retry: true,
  });
});

// ── Folder shares: leave items out and count them ────────────────────────────

test('folder_shares_leave_out_binary_and_upper_repair_names_and_count_them', () => {
  const plan = folderSharePlan([
    { fileId: 'a', name: 'string', content: 'string' },
    { fileId: 'b', name: 'binary', content: 'binary' },
    { fileId: 'c', name: 'upper_repair', content: 'upper_repair' },
    { fileId: 'd', name: 'string_or_binary', content: 'string' },
  ]);
  expect(plan.included).toEqual(['a', 'd']);
  expect(plan.excluded).toEqual(['b', 'c']);
  expect(plan.copy).toBe("2 files can't be shared yet");
});

test('a_single_excluded_descendant_reads_as_one_file', () => {
  const plan = folderSharePlan([{ fileId: 'a', name: 'upper_repair', content: 'unknown' }]);
  expect(plan.excluded).toEqual(['a']);
  expect(plan.copy).toBe("1 file can't be shared yet");
});

test('a_fully_included_folder_has_no_exclusion_note', () => {
  const plan = folderSharePlan([{ fileId: 'a', name: 'string', content: 'string' }]);
  expect(plan.excluded).toEqual([]);
  expect(plan.copy).toBeNull();
});

// ── Moves stay allowed, including for read-only names ────────────────────────

test('a_move_is_allowed_for_an_upper_repair_name_but_its_rename_is_not', () => {
  expect(legacyMovePlan('upper_repair', 'new-name.txt')).toEqual({ move: true, rename: false });
});

test('a_move_with_a_new_name_renames_only_when_the_name_half_allows', () => {
  expect(legacyMovePlan('string', 'new-name.txt')).toEqual({ move: true, rename: true });
  expect(legacyMovePlan('string', null)).toEqual({ move: true, rename: false });
});
