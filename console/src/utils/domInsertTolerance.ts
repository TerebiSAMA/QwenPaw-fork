/**
 * Tolerate DOM mutations performed behind React's back.
 *
 * React keeps its own bookkeeping of every host node it created. When a
 * third party mutates that subtree - a browser UI layer (translation,
 * appearance, reading mode) wrapping a React-managed text node in its own
 * element, a password-manager or translation extension injecting nodes, a
 * WebView shell - React's bookkeeping diverges from the real DOM.
 *
 * The next commit then calls `parent.insertBefore(node, refNode)` with a
 * `refNode` that has since been re-parented or detached. The DOM spec
 * requires `refNode` to be a direct child of `parent`, so the browser
 * throws `NotFoundError`, which React surfaces as a render error and the
 * nearest error boundary turns into a full-page fallback. Because a route
 * change is the only thing that resets that boundary, the page then stays
 * broken until a manual reload.
 *
 * Rather than fighting the injector, degrade the call:
 *
 * - `refNode` detached -> append the node instead (position lost once, but
 *   the next commit re-orders correctly).
 * - `refNode` under a different parent -> drop this insertion; the fibre
 *   being placed is already reachable another way, and letting the commit
 *   proceed keeps React's bookkeeping intact.
 *
 * Deliberately narrow: only calls that would have thrown are intercepted,
 * every valid call is forwarded untouched.
 */

const GUARD_FLAG = "__qwenpawDomInsertToleranceInstalled";

interface GuardWindow extends Window {
  [GUARD_FLAG]?: boolean;
}

let installed = false;

/** Installs the guard once per page. No-op outside the browser. */
export function installDomInsertTolerance(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof Node === "undefined") return;
  const win = window as GuardWindow;
  if (win[GUARD_FLAG]) {
    installed = true;
    return;
  }
  win[GUARD_FLAG] = true;
  installed = true;

  const originalInsertBefore = Node.prototype.insertBefore;

  Node.prototype.insertBefore = function insertBeforeTolerant<T extends Node>(
    this: Node,
    newNode: T,
    refNode: Node | null,
  ): T {
    // Fast path: the spec-compliant call site, which is all React needs.
    if (
      refNode === null ||
      refNode === undefined ||
      refNode.parentNode === this
    ) {
      return originalInsertBefore.call(this, newNode, refNode) as T;
    }

    // The reference node is no longer where React thinks it is. Do not
    // throw: place the node in a valid position and let the next commit
    // reconcile the order.
    if (refNode.parentNode === null) {
      return originalInsertBefore.call(this, newNode, null) as T;
    }

    if (import.meta.env?.DEV) {
      console.warn(
        "[dom-tolerance] insertBefore reference node is not a child of the " +
          "parent; insertion skipped",
        { parent: this.nodeName, ref: refNode.nodeName },
      );
    }
    return newNode;
  };

  const originalRemoveChild = Node.prototype.removeChild;

  Node.prototype.removeChild = function removeChildTolerant<T extends Node>(
    this: Node,
    child: T,
  ): T {
    // Same class of race: the node was moved out from under us first.
    // Report success so React can continue instead of failing the commit.
    if (child.parentNode !== this) {
      if (import.meta.env?.DEV) {
        console.warn(
          "[dom-tolerance] removeChild child does not belong to this parent; " +
            "removal skipped",
          { parent: this.nodeName, child: child.nodeName },
        );
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };
}
