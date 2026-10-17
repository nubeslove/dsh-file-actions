window.__ModuleLoader__.load({
	id: "dsh-file-actions",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";

		var API = "/api/file-actions";
		var MENU_ID = "dsh-file-actions-menu";
		var STYLE_ID = "dsh-file-actions-style";
		var INSTALLED_KEY = "__dshFileActionsInstalled";

		// 常见文本类扩展名：额外提供「用浏览器打开」
		var BROWSER_EXT = /\.(?:html?|xhtml|svg|md|markdown|txt|log|json|xml|csv|ya?ml|toml|ini|css|js|mjs|ts)$/i;

		// 判断一段文本是否像本地文件路径（用于行内代码的兜底识别）
		var PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/)?[^\r\n<>|?*\u0000-\u001f]*[\\/][^\r\n<>|?*\u0000-\u001f]+$|^[^\r\n<>|?*\u0000-\u001f\\/]+\.(?:txt|md|markdown|html?|xhtml|svg|json|xml|csv|ya?ml|toml|ini|conf|log|js|mjs|cjs|ts|tsx|jsx|css|scss|less|py|rs|go|java|cs|cpp|c|h|hpp|sh|ps1|bat|cmd|sql|png|jpe?g|gif|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|7z|rar|exe|dll)$/i;

		// ------------------------------------------------------------ 样式

		var CSS = [
			"#" + MENU_ID + "{position:fixed;z-index:10050;min-width:210px;max-width:min(440px,92vw);padding:5px;background:var(--dsh-bg-elevated,#1f2229);color:var(--dsh-text-primary,#e6e8eb);border:1px solid rgba(127,127,127,.28);border-radius:11px;box-shadow:0 18px 48px rgba(0,0,0,.45);font-size:12.5px;line-height:1.5;user-select:none;backdrop-filter:blur(12px)}",
			"#" + MENU_ID + " .dfa-head{padding:6px 9px 7px;border-bottom:1px solid rgba(127,127,127,.2);margin-bottom:4px}",
			"#" + MENU_ID + " .dfa-name{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			"#" + MENU_ID + " .dfa-path{opacity:.5;font-size:11px;direction:rtl;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsh-font-mono,ui-monospace,Consolas,monospace)}",
			"#" + MENU_ID + " .dfa-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
			"#" + MENU_ID + " .dfa-item:hover,#" + MENU_ID + " .dfa-item:focus-visible{background:rgba(127,127,127,.16);outline:none}",
			"#" + MENU_ID + " .dfa-item[data-busy=\"1\"]{opacity:.55;cursor:progress}",
			"#" + MENU_ID + " .dfa-sep{height:1px;margin:4px 6px;background:rgba(127,127,127,.2)}",
			"#" + MENU_ID + " .dfa-icon{width:15px;flex:0 0 15px;opacity:.75;text-align:center;font-size:12px}",
			"#dfa-toast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:10060;max-width:min(560px,88vw);padding:8px 13px;border-radius:9px;background:rgba(28,31,38,.96);color:#e6e8eb;border:1px solid rgba(127,127,127,.3);box-shadow:0 10px 30px rgba(0,0,0,.4);font-size:12px;line-height:1.5}",
			"#dfa-toast[data-err=\"1\"]{border-color:rgba(240,128,128,.55);color:#f7b0b0}"
		].join("\n");

		function ensureStyle() {
			if (document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------ 提示

		function toast(text, isError) {
			var old = document.getElementById("dfa-toast");
			if (old) old.remove();
			var el = document.createElement("div");
			el.id = "dfa-toast";
			if (isError) el.setAttribute("data-err", "1");
			el.textContent = text;
			document.body.appendChild(el);
			window.setTimeout(function () {
				if (el.parentNode) el.remove();
			}, isError ? 4200 : 2200);
		}

		// ------------------------------------------------------------ 引用识别

		/** 把 `@path`、`@"path"`、`file:///...` 还原为可读路径。 */
		function cleanToken(raw) {
			var text = String(raw == null ? "" : raw).trim();
			if (!text) return "";
			if (text.charAt(0) === "@") text = text.slice(1);
			if (text.length > 1 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
				text = text.slice(1, -1);
			}
			if (/^file:\/\//i.test(text)) {
				try {
					var url = new URL(text);
					text = decodeURIComponent(url.pathname);
					if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1);
				} catch (e) {
					// 保持原样，交给宿主判定
				}
			}
			return text.trim();
		}

		/**
		 * 从右键命中的元素向上寻找可识别的文件引用。
		 * 依次尝试：ref chip、file:// 链接、行内代码文本。
		 * @returns {{ path: string, source: string } | null}
		 */
		function resolveFromEvent(target) {
			if (!(target instanceof Element)) return null;

			var chip = target.closest("[data-ref-chip]");
			if (chip) {
				var kind = chip.getAttribute("data-ref-chip");
				if (kind === "session" || kind === "skill") return null;
				var title = chip.getAttribute("title") || "";
				var chipPath = cleanToken(title) || cleanToken(chip.textContent || "");
				if (chipPath) return { path: chipPath, source: "chip:" + kind };
			}

			var link = target.closest("a[href]");
			if (link) {
				var href = link.getAttribute("href") || "";
				if (/^file:\/\//i.test(href)) {
					var linkPath = cleanToken(href);
					if (linkPath) return { path: linkPath, source: "link" };
				}
			}

			var code = target.closest("code");
			if (code) {
				var text = (code.textContent || "").trim();
				if (text && text.length <= 4096 && PATH_LIKE.test(text)) {
					return { path: text, source: "code" };
				}
			}

			return null;
		}

		// ------------------------------------------------------------ 菜单

		var menuEl = null;
		var closeHandlers = null;

		function closeMenu() {
			if (menuEl) {
				menuEl.remove();
				menuEl = null;
			}
			if (closeHandlers) {
				document.removeEventListener("pointerdown", closeHandlers.pointer, true);
				document.removeEventListener("keydown", closeHandlers.key, true);
				window.removeEventListener("resize", closeHandlers.resize);
				window.removeEventListener("scroll", closeHandlers.resize, true);
				closeHandlers = null;
			}
		}

		function basename(path) {
			var parts = String(path).split(/[\\/]/).filter(Boolean);
			return parts.length ? parts[parts.length - 1] : path;
		}

		function extensionOf(path) {
			var name = basename(path);
			var dot = name.lastIndexOf(".");
			return dot > 0 ? name.slice(dot).toLowerCase() : "";
		}

		function callAction(action, path, buttonEl) {
			if (buttonEl) buttonEl.setAttribute("data-busy", "1");
			return fetch(API + "/exec", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: action, path: path })
			}).then(function (res) {
				return res.json().catch(function () {
					return { ok: false, error: "HTTP " + res.status };
				});
			}).then(function (payload) {
				if (!payload || !payload.ok) {
					toast((payload && payload.error) || "操作失败", true);
					return false;
				}
				return true;
			}).catch(function (err) {
				toast(String((err && err.message) || err), true);
				return false;
			});
		}

		function makeItem(label, icon, onClick) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dfa-item";
			btn.setAttribute("role", "menuitem");

			var ic = document.createElement("span");
			ic.className = "dfa-icon";
			ic.textContent = icon;
			btn.appendChild(ic);

			var txt = document.createElement("span");
			txt.textContent = label;
			btn.appendChild(txt);

			btn.addEventListener("click", function () {
				onClick(btn);
			});
			return btn;
		}

		function makeSep() {
			var sep = document.createElement("div");
			sep.className = "dfa-sep";
			return sep;
		}

		function buildMenu(info) {
			var path = info.path;
			var ext = extensionOf(path);
			var menu = document.createElement("div");
			menu.id = MENU_ID;
			menu.setAttribute("role", "menu");

			var head = document.createElement("div");
			head.className = "dfa-head";
			var name = document.createElement("div");
			name.className = "dfa-name";
			name.textContent = basename(path);
			var full = document.createElement("div");
			full.className = "dfa-path";
			full.textContent = path;
			head.appendChild(name);
			head.appendChild(full);
			menu.appendChild(head);

			menu.appendChild(makeItem("用默认程序打开", "↗", function (btn) {
				callAction("open", path, btn).then(function (ok) {
					if (ok) closeMenu();
				});
			}));

			if (BROWSER_EXT.test(ext)) {
				menu.appendChild(makeItem("用浏览器打开", "◍", function (btn) {
					callAction("browser", path, btn).then(function (ok) {
						if (ok) closeMenu();
					});
				}));
			}

			menu.appendChild(makeItem("在文件夹中显示", "▤", function (btn) {
				callAction("reveal", path, btn).then(function (ok) {
					if (ok) closeMenu();
				});
			}));

			menu.appendChild(makeSep());

			menu.appendChild(makeItem("复制完整路径", "⧉", function (btn) {
				var text = path;
				var done = function (success) {
					toast(success ? "已复制路径" : "复制失败", !success);
					if (success) closeMenu();
				};
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(function () {
						done(true);
					}, function () {
						done(false);
					});
					return;
				}
				var area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.left = "-9999px";
				document.body.appendChild(area);
				area.select();
				var ok = false;
				try {
					ok = document.execCommand("copy");
				} catch (e) {
					ok = false;
				}
				area.remove();
				done(ok);
			}));

			return menu;
		}

		function placeMenu(menu, x, y) {
			document.body.appendChild(menu);
			var rect = menu.getBoundingClientRect();
			var margin = 8;
			var left = x;
			var top = y;
			if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - rect.width - margin);
			if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height);
			if (top < margin) top = margin;
			menu.style.left = left + "px";
			menu.style.top = top + "px";
		}

		function openMenu(event, info) {
			closeMenu();
			var menu = buildMenu(info);
			placeMenu(menu, event.clientX, event.clientY);
			menuEl = menu;

			var onPointer = function (e) {
				if (menu.contains(e.target)) return;
				closeMenu();
			};
			var onKey = function (e) {
				if (e.key === "Escape") {
					e.preventDefault();
					closeMenu();
				}
			};
			var onMove = function () {
				closeMenu();
			};

			closeHandlers = { pointer: onPointer, key: onKey, resize: onMove };
			// 延后一拍注册，避免当前这次右键事件立刻把自己关掉
			window.setTimeout(function () {
				if (!menuEl) return;
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				window.addEventListener("resize", onMove);
				window.addEventListener("scroll", onMove, true);
			}, 0);

			var first = menu.querySelector(".dfa-item");
			if (first) {
				try {
					first.focus({ preventScroll: true });
				} catch (e) {
					// 聚焦失败不影响菜单可用性
				}
			}
		}

		// ------------------------------------------------------------ 事件

		function onContextMenu(event) {
			if (!event.target) return;
			var info = resolveFromEvent(event.target);
			if (!info) return;
			event.preventDefault();
			event.stopPropagation();
			if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
			openMenu(event, info);
		}

		// ------------------------------------------------------------ 入口

		function apply(ctx) {
			if (window[INSTALLED_KEY]) return;
			window[INSTALLED_KEY] = true;

			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(function () {
					ensureStyle();
					document.addEventListener("contextmenu", onContextMenu, true);
					return function () {
						document.removeEventListener("contextmenu", onContextMenu, true);
						closeMenu();
						window[INSTALLED_KEY] = false;
					};
				}, "file-actions: contextmenu");
				return;
			}

			ensureStyle();
			document.addEventListener("contextmenu", onContextMenu, true);
		}

		module.exports = { apply: apply, inject: [] };
		return module.exports;
	}
});
