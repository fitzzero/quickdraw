export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon?: unknown;
  children?: NavItem[];
  defaultExpanded?: boolean;
  requireAuth?: boolean;
  dynamicChildren?: boolean;
  serviceName?: string;
  minAccessLevel?: string;
}

export interface BreadcrumbItem {
  label: string;
  href: string;
  siblings?: { label: string; href: string }[];
}

/**
 * Find a nav item by its href (exact match, searching children recursively).
 */
export function findNavItemByHref(items: NavItem[], href: string): NavItem | undefined {
  for (const item of items) {
    if (item.href === href) return item;
    if (item.children) {
      const found = findNavItemByHref(item.children, href);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Find the parent nav item containing a child with the given href.
 */
export function findParentNavItem(items: NavItem[], href: string): NavItem | undefined {
  for (const item of items) {
    if (item.children) {
      const childMatch = item.children.find((c) => c.href === href);
      if (childMatch) return item;
      const nested = findParentNavItem(item.children, href);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Build breadcrumb items from a pathname using the provided navigation config.
 */
export function buildBreadcrumbs(pathname: string, navigation: NavItem[]): BreadcrumbItem[] {
  const breadcrumbs: BreadcrumbItem[] = [];

  if (pathname === "/") {
    breadcrumbs.push({
      label: "Home",
      href: "/",
      siblings: navigation
        .filter((item) => item.href === "/" || !item.requireAuth)
        .map((item) => ({ label: item.label, href: item.href })),
    });
    return breadcrumbs;
  }

  const segments = pathname.split("/").filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath += `/${segment}`;
    const navItem = findNavItemByHref(navigation, currentPath);

    if (navItem) {
      const parent = findParentNavItem(navigation, currentPath);
      const siblingItems = parent?.children ?? navigation;

      breadcrumbs.push({
        label: navItem.label,
        href: navItem.href,
        siblings: siblingItems.map((item) => ({
          label: item.label,
          href: item.href,
        })),
      });
    } else {
      breadcrumbs.push({
        label: segment,
        href: currentPath,
      });
    }
  }

  return breadcrumbs;
}

/**
 * Check if a route requires authentication by searching the navigation config.
 */
export function routeRequiresAuth(
  pathname: string,
  navigation: NavItem[],
  userMenuItems?: NavItem[],
): boolean {
  const navItem = findNavItemByHref(navigation, pathname);
  if (navItem) return navItem.requireAuth ?? false;

  if (userMenuItems) {
    const userItem = findNavItemByHref(userMenuItems, pathname);
    if (userItem) return userItem.requireAuth ?? false;
  }

  const segments = pathname.split("/").filter(Boolean);
  let currentPath = "";
  for (const segment of segments) {
    currentPath += `/${segment}`;
    const item = findNavItemByHref(navigation, currentPath);
    if (item?.requireAuth) return true;
  }

  return false;
}
