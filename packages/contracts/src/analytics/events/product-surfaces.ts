/**
 * @module analytics/events/product-surfaces
 * Analytics contracts for local product navigation and catalog actions.
 *
 * These payloads intentionally carry no tenant, Workspace, member, billing,
 * or Team dimensions. Collaboration analytics belongs to the Project-scoped
 * self-hosted contract when it is explicitly instrumented.
 */

export type TrackingResourceScope = 'official' | 'personal' | 'unknown';
export type TrackingEntryPage =
  | 'home'
  | 'community'
  | 'projects'
  | 'design_systems'
  | 'plugins'
  | 'settings'
  | 'project';

export interface EntryNavigationClickProps {
  page_name: TrackingEntryPage;
  area: 'entry_nav';
  element: 'nav_item' | 'search';
  target?: TrackingEntryPage | 'search';
  entry_from?: 'sidebar';
}

export interface EntryUtilityClickProps {
  page_name: TrackingEntryPage;
  area: 'entry_utility';
  element: 'settings' | 'github' | 'discord' | 'twitter' | 'email';
}

export type TrackingProjectCollectionPage = 'home' | 'projects';
export type TrackingCountBucket = '0' | '1' | '2_5' | '6_10' | '11_plus';

export interface ProjectCollectionClickProps {
  page_name: TrackingProjectCollectionPage;
  area: 'project_collection';
  element:
    | 'project_open'
    | 'more_menu'
    | 'rename'
    | 'duplicate'
    | 'delete'
    | 'multi_select_toggle'
    | 'bulk_delete'
    | 'filter'
    | 'sort'
    | 'view_toggle';
  project_key?: string;
  selection_count_bucket?: TrackingCountBucket;
  filter_type?: 'owner' | 'project_type';
  filter_value?: string;
  sort_value?: 'updated_desc' | 'updated_asc' | 'name_asc';
  view_value?: 'grid' | 'list';
}

export interface CommunityTemplateClickProps {
  page_name: 'community';
  area: 'community_templates';
  element: 'template_detail' | 'copy_prompt' | 'remix' | 'use_prompt' | 'filter';
  template_key?: string;
  template_type?: string;
  resource_scope?: TrackingResourceScope;
  filter_type?: 'category' | 'subtype';
  filter_value?: string;
}

export interface ExtensionMarketplaceClickProps {
  page_name: 'plugins';
  area: 'extension_marketplace';
  element: 'details' | 'use' | 'add' | 'create' | 'filter';
  extension_key?: string;
  extension_kind: 'expert_plugin' | 'skill';
  resource_scope: TrackingResourceScope;
}

export interface ProjectActionResultProps {
  page_name: TrackingProjectCollectionPage;
  area: 'project_collection';
  action: 'duplicate' | 'delete' | 'bulk_delete';
  result: 'success' | 'partial_success' | 'failed';
  requested_count: number;
  succeeded_count: number;
  failed_count: number;
  duration_ms: number;
  error_code?: string;
}

export interface CatalogResourceActionResultProps {
  page_name: 'design_systems' | 'plugins';
  area: 'catalog_resource';
  resource_kind: 'design_system' | 'expert_plugin' | 'skill';
  resource_scope: TrackingResourceScope;
  action: 'download' | 'add';
  result: 'success' | 'failed';
  duration_ms: number;
  error_code?: string;
}
