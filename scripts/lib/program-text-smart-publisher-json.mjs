import { projectSmartKbPublisherJson, SMART_KB_PUBLISHER_SOURCE_PROFILES, SMART_GUIDE_KB_SOURCE_PROFILES } from "./program-text-smart-kb-publisher-json.mjs";
import { createHash } from "node:crypto";
import { load } from "cheerio";

// Finite, reviewed publisher model. This module never evaluates site JavaScript,
// makes requests, or decides source/fact approval or transport completeness.
export const PROJECTOR_VERSION = "smart-publisher-json-v1";
export const SMART_PUBLISHER_JSON_SCHEMA = "awardping.smart-publisher-json-projection.v1";
export const SMART_PUBLISHER_DATA_SCHEMA = "awardping.smart-publisher-data.v1";
const OWNER = "d7d4d117-f312-456f-a75c-3dbd5d372c99";
const PORTAL = "f2a05466db71c300b67330ca7c9619f0";
const HOME = "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget";
const ELIGIBILITY = "/result/containers/0/rows/0/columns/0/widgets/1/widget";
export const SMART_PUBLISHER_JSON_SOURCE_PROFILES = Object.freeze([
  Object.freeze({ key: "home", id: "58aefec0-0d42-4b7b-9887-60d25940b3d0", shared_award_id: OWNER,
    url: "https://www.smartscholarship.org/smart", page_id: "smart_index", page_sys_id: "2a47254fdb350300ecc734cc7c961992", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: HOME }),
  Object.freeze({ key: "eligibility", id: "c33cc2f4-2cbd-458c-b630-537eb3d50f72", shared_award_id: OWNER,
    url: "https://www.smartscholarship.org/smart/en?id=smart_eligibility", page_id: "smart_eligibility", page_sys_id: "a15b540a872a86105831a7530cbb355c", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: ELIGIBILITY }),
  // key is the reviewed model family; source identity remains the literal alias.
  Object.freeze({ key: "home", id: "92eebc07-7392-4136-ba13-d9cd5455c8f9", shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "homepage", version: PROJECTOR_VERSION,
    url: "https://www.smartscholarship.org/smart/en", page_id: "smart_index", page_sys_id: "2a47254fdb350300ecc734cc7c961992", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: HOME }),
]);
const MAX_BYTES = 512 * 1024;
const fail = code => { throw Object.assign(new Error(`SMART publisher JSON held: ${code}`), { code: `program_text_smart_json_${code}` }); };
const hash = value => createHash("sha256").update(value).digest("hex");
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pointerKey = key => key.replaceAll("~", "~0").replaceAll("/", "~1");
const norm = x => x.replace(/\s+/gu, " ").trim();
const check = (condition, code) => { if (!condition) fail(code); };
const textValue = (x, max = MAX_BYTES) => typeof x === "string" && x.length <= max && !x.includes("\0") && Buffer.from(x).toString("utf8") === x;

/** Parse the entire bounded original, rejecting duplicate decoded keys at ANY
 * depth. JSON.parse alone silently discards those keys. Keep exact raw scalar
 * spans for labelled publisher-data provenance; never expose unrelated values. */
function parseOriginal(raw) {
  check(typeof raw === "string" || raw instanceof Uint8Array, "raw_bytes_required");
  const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
  check(bytes.length > 0 && bytes.length <= MAX_BYTES, "raw_size");
  let input;
  try { input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail("invalid_utf8"); }
  check(Buffer.from(input).equals(bytes) && (typeof raw !== "string" || input === raw), "invalid_utf8");
  let at = 0, nodes = 0;
  const spans = new Map();
  const white = () => { while (/[\x20\t\r\n]/.test(input[at] || "x")) at++; };
  function string() {
    check(input[at] === '"', "invalid_json"); const start = at++;
    while (at < input.length) {
      const ch = input[at++];
      if (ch === "\\") { at++; continue; }
      if (ch === '"') { let value; try { value = JSON.parse(input.slice(start, at)); } catch { fail("invalid_json"); }
        check(textValue(value), "invalid_json_string"); return value; }
    }
    fail("invalid_json");
  }
  function value(pointer, depth) {
    check(depth <= 64 && ++nodes <= 50000, "json_complexity"); white(); const start = at; let result;
    if (input[at] === "{") {
      at++; result = Object.create(null); white();
      if (input[at] !== "}") for (;;) {
        white(); const key = string(); check(!Object.hasOwn(result, key), "duplicate_key"); white(); check(input[at++] === ":", "invalid_json");
        result[key] = value(pointer + "/" + pointerKey(key), depth + 1); white();
        if (input[at] !== ",") break; at++;
      }
      check(input[at++] === "}", "invalid_json");
    } else if (input[at] === "[") {
      at++; result = []; white();
      if (input[at] !== "]") for (;;) { result.push(value(pointer + "/" + result.length, depth + 1)); white(); if (input[at] !== ",") break; at++; }
      check(input[at++] === "]", "invalid_json");
    } else if (input[at] === '"') result = string();
    else {
      const match = input.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      check(match, "invalid_json"); at += match[0].length; result = JSON.parse(match[0]);
      check(typeof result !== "number" || Number.isFinite(result), "invalid_number");
    }
    spans.set(pointer, { start_utf16: start, end_utf16: at }); return result;
  }
  const document = value("", 0); white(); check(at === input.length, "invalid_json");
  return { document, input, spans, bytes };
}

// REVIEWED_MODEL contains only public identifiers, binding grammar and hashes of
// reviewed static client/link code; no captured user/session/nonce values.
const REVIEWED_MODEL = {
  "profiles": {
    "home": [
      {
        "pointer": "/result/theme/footer",
        "id": "f908e94fdb350300ecc734cc7c9619b2"
      },
      {
        "pointer": "/result/theme/header",
        "id": "69505de91bce90107695a82fe54bcbc1"
      },
      {
        "pointer": "/result/theme/header/data/menu",
        "id": "5ef595c1cb12020000f8d856634c9c6e"
      },
      {
        "pointer": "/result/theme/header/data/wCountdown",
        "id": "5947caa91bfc94107695a82fe54bcb5f"
      },
      {
        "pointer": "/result/theme/header/data/wCountdown/data/countDownWidget",
        "id": "281b37e04f6e13004b5c30318110c74d"
      },
      {
        "pointer": "/result/theme/header/data/announcementWidget",
        "id": "1e6a42edd442b2007f44c8341d4d3b57"
      },
      {
        "pointer": "/result/theme/header/data/loginWidget",
        "id": "6506d341cb33020000f8d856634c9cdc"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget",
        "id": "6b86714a1b2dad507695a82fe54bcbac"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/future_leaders",
        "id": "c9795b2847b89210c205f9ee626d43f2"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/future_leaders/data/image_widget",
        "id": "dda3e7808762fe105831a7530cbb3596"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/scholar_recipients",
        "id": "c9795b2847b89210c205f9ee626d43f2"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/scholar_recipients/data/image_widget",
        "id": "dda3e7808762fe105831a7530cbb3596"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/program_and_eligibility",
        "id": "c9795b2847b89210c205f9ee626d43f2"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/program_and_eligibility/data/image_widget",
        "id": "dda3e7808762fe105831a7530cbb3596"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/rows/0/columns/0/widgets/0/widget/data/smart_carousel",
        "id": "cf3766131ba875107695a82fe54bcb0f"
      }
    ],
    "eligibility": [
      {
        "pointer": "/result/theme/footer",
        "id": "f908e94fdb350300ecc734cc7c9619b2"
      },
      {
        "pointer": "/result/theme/header",
        "id": "69505de91bce90107695a82fe54bcbc1"
      },
      {
        "pointer": "/result/theme/header/data/menu",
        "id": "5ef595c1cb12020000f8d856634c9c6e"
      },
      {
        "pointer": "/result/theme/header/data/wCountdown",
        "id": "5947caa91bfc94107695a82fe54bcb5f"
      },
      {
        "pointer": "/result/theme/header/data/wCountdown/data/countDownWidget",
        "id": "281b37e04f6e13004b5c30318110c74d"
      },
      {
        "pointer": "/result/theme/header/data/announcementWidget",
        "id": "1e6a42edd442b2007f44c8341d4d3b57"
      },
      {
        "pointer": "/result/theme/header/data/loginWidget",
        "id": "6506d341cb33020000f8d856634c9cdc"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/widgets/0/widget",
        "id": "6914f1b61b8a5c107695a82fe54bcbb9"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/widgets/0/widget/data/technical_help_widget",
        "id": "06cb6e981b9fc1507695a82fe54bcb40"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/widgets/1/widget",
        "id": "437c908a872a86105831a7530cbb3508"
      },
      {
        "pointer": "/result/containers/0/rows/0/columns/0/widgets/1/widget/data/eligibility_info",
        "id": "7f5af26e87e28a105831a7530cbb35b8"
      }
    ]
  },
  "widgets": {
    "f908e94fdb350300ecc734cc7c9619b2": {
      "data_keys": [
        "portal",
        "showLinks"
      ]
    },
    "69505de91bce90107695a82fe54bcbc1": {
      "data_keys": [
        "announcementPicker",
        "announcementWidget",
        "connect_support_queue_id",
        "hasLogin",
        "loginWidget",
        "login_page",
        "menu",
        "profileBtnMsg",
        "pyOpenNextYear",
        "showApply",
        "showClosedWarning",
        "typeahead",
        "wCountdown"
      ],
      "code": {
        "client": "d6c5984891aa25ac65389f6ee870a3b1d653f009125ff879085a68d53e79aab9",
        "link": "5c25aad8524c2adaf5f0b32b957b2f7c56da5dd2200d4e2aaf28b9111944eb97"
      },
      "grammar": {
        "directives": [
          [
            "sp-widget",
            "widget",
            "c.data.announcementWidget"
          ],
          [
            "sp-widget",
            "widget",
            "data.menu"
          ],
          [
            "li",
            "ng-if",
            "!user.logged_in && page.id != portal.login_page_dv && !data.hasLogin"
          ],
          [
            "a",
            "ng-click",
            "LoginRedirect()"
          ],
          [
            "li",
            "ng-if",
            "user.logged_in"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.announcementPicker"
          ],
          [
            "a",
            "ng-href",
            "?id=user_profile&sys_id={{::user.sys_id}}"
          ],
          [
            "li",
            "ng-if",
            "::!isViewNative"
          ],
          [
            "li",
            "ng-if",
            "user.logged_in"
          ],
          [
            "a",
            "ng-href",
            "?id=user_profile&sys_id={{::user.sys_id}}"
          ],
          [
            "li",
            "ng-if",
            "::!isViewNative && user.logged_in"
          ],
          [
            "ul",
            "ng-if",
            "(!user.logged_in && page.id != portal.login_page_dv && !data.hasLogin)"
          ],
          [
            "a",
            "ng-click",
            "LoginRedirect()"
          ],
          [
            "ul",
            "ng-if",
            "::user.logged_in"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.announcementPicker"
          ],
          [
            "a",
            "ng-href",
            "?id=user_profile&sys_id={{::user.sys_id}}"
          ],
          [
            "li",
            "ng-if",
            "::!isViewNative"
          ],
          [
            "a",
            "ng-href",
            "?id=user_profile&sys_id={{::user.sys_id}}"
          ],
          [
            "li",
            "ng-if",
            "::!isViewNative"
          ],
          [
            "div",
            "ng-if",
            "data.showClosedWarning"
          ],
          [
            "div",
            "ng-if",
            "!data.showClosedWarning"
          ],
          [
            "div",
            "ng-if",
            "data.showApply"
          ],
          [
            "sp-widget",
            "ng-if",
            "data.wCountdown"
          ],
          [
            "sp-widget",
            "widget",
            "data.wCountdown"
          ],
          [
            "sp-widget",
            "widget",
            "data.menu"
          ]
        ],
        "expressions": [
          "data.profileBtnMsg",
          "::user.name",
          "::user.sys_id",
          "::portal.logoutUrl",
          "::user.sys_id",
          "::user.name",
          "::portal.logoutUrl",
          "data.profileBtnMsg",
          "::user.name",
          "::user.sys_id",
          "::portal.logoutUrl",
          "::user.sys_id",
          "::user.name",
          "::portal.logoutUrl",
          "data.pyOpenNextYear"
        ],
        "active": [
          "script",
          "script",
          "script"
        ]
      }
    },
    "5ef595c1cb12020000f8d856634c9c6e": {
      "data_keys": [
        "guidedTours",
        "isLoggedIn",
        "menu",
        "replace",
        "showTours",
        "showWishlist"
      ]
    },
    "5947caa91bfc94107695a82fe54bcb5f": {
      "data_keys": [
        "countDownWidget",
        "showCountDown"
      ],
      "code": {
        "client": "72bd2c7ba825c3d1c6345ec5b57d6b9816ad2b90700411673e3436e9ac0fb2f1",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "div",
            "ng-show",
            "data.showCountDown"
          ],
          [
            "sp-widget",
            "widget",
            "data.countDownWidget"
          ]
        ],
        "expressions": [],
        "active": []
      }
    },
    "281b37e04f6e13004b5c30318110c74d": {
      "data_keys": [
        "deadLine",
        "status",
        "visible"
      ],
      "code": {
        "client": "56f9d07041deb9db3f867302e4b28fef84a48301d33f76f21c18882627b7bd2d",
        "link": null
      },
      "grammar": {
        "directives": [],
        "expressions": [
          "data.status"
        ],
        "active": []
      }
    },
    "1e6a42edd442b2007f44c8341d4d3b57": {
      "data_keys": [
        "informationAnnouncementIDs",
        "informationAnnouncements",
        "outageIDs",
        "outages",
        "showAnnouncements"
      ]
    },
    "6506d341cb33020000f8d856634c9cdc": {
      "data_keys": [
        "certAuthRedirect",
        "default_idp",
        "errorMsg",
        "errorMsg2",
        "forgetMe",
        "forgotPwdLinkProp",
        "isMultiSSOActive",
        "isShowLoginWithIdps",
        "is_logged_in",
        "multiFactorAuthEnabled",
        "multisso_enabled",
        "pageURI",
        "passwordMsg",
        "pswdResetUrl",
        "rememberMeDefault",
        "ssoSelectorFieldLabel",
        "usernameMsg"
      ]
    },
    "6b86714a1b2dad507695a82fe54bcbac": {
      "data_keys": [
        "facilities",
        "future_leaders",
        "program_and_eligibility",
        "pyOpenNextYear",
        "scholar_recipients",
        "scholars",
        "selectionLink",
        "showApply",
        "showApplyButton",
        "showClosedWarning",
        "showPanelistButton",
        "showPanelistRegButton",
        "showSelectionButton",
        "smart_carousel",
        "stipendText",
        "universities"
      ],
      "code": {
        "client": "e1abf9f2aa2714ce6868e005f1da9d904c1bd5c033c62271790fb6d12d7dea5e",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "div",
            "ng-if",
            "c.data.smart_carousel"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.smart_carousel"
          ],
          [
            "a",
            "ng-if",
            "data.showApplyButton"
          ],
          [
            "a",
            "ng-if",
            "data.showPanelistRegButton"
          ],
          [
            "a",
            "ng-if",
            "data.showPanelistButton"
          ],
          [
            "a",
            "ng-if",
            "data.showSelectionButton"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.program_and_eligibility"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.future_leaders"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.scholar_recipients"
          ]
        ],
        "expressions": [
          "data.stipendText",
          "data.facilities | number",
          "data.scholars | number"
        ],
        "active": []
      }
    },
    "c9795b2847b89210c205f9ee626d43f2": {
      "data_keys": [
        "background",
        "buttons",
        "description",
        "image_alt",
        "image_attachment",
        "image_attachment_filename",
        "image_fit",
        "image_location",
        "image_overlay",
        "image_src",
        "image_title",
        "image_widget",
        "title"
      ],
      "code": {
        "client": "173bcec10f1d2645e73a61e8a144beabf156ada7811481b34571b34a091fcfdc",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "div",
            "ng-class",
            "{'front-template': c.data.background != ''}"
          ],
          [
            "div",
            "ng-class",
            "{'slick-slide': c.data.background != ''}"
          ],
          [
            "div",
            "ng-if",
            "data.image_location == 'right'"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.image_widget"
          ],
          [
            "div",
            "ng-if",
            "data.image_location == 'left'"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.image_widget"
          ],
          [
            "div",
            "ng-class",
            "{'section-main': c.data.image_location == 'left'}"
          ],
          [
            "div",
            "ng-bind-html",
            "data.description"
          ],
          [
            "a",
            "ng-repeat",
            "b in data.buttons"
          ],
          [
            "a",
            "ng-href",
            "{{b.href}}"
          ],
          [
            "div",
            "ng-class",
            "{'button-container-active': b.active === true}"
          ],
          [
            "div",
            "ng-repeat",
            "section in data.sections"
          ],
          [
            "img",
            "ng-src",
            "{{ section.image }}"
          ],
          [
            "div",
            "ng-if",
            "data.image_location == 'right'"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.image_widget"
          ]
        ],
        "expressions": [
          "c.data.title",
          "b.href",
          "b.title",
          "section.image",
          "section.title",
          "section.title",
          "section.description"
        ],
        "active": []
      },
      "optional_sections": true
    },
    "dda3e7808762fe105831a7530cbb3596": {
      "data_keys": [
        "image_alt",
        "image_attachment",
        "image_attachment_filename",
        "image_fit",
        "image_overlay",
        "image_src",
        "image_title"
      ],
      "code": {
        "client": "ba556c56492a85da3b7bcc02c1c518c3c3801c6322b3d5a99c4818b72febc70d",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "a",
            "ng-if",
            "data.image_attachment != ''"
          ],
          [
            "a",
            "ng-class",
            "{'image-fit': c.data.image_fit == 'fit'}"
          ],
          [
            "a",
            "ng-click",
            "googleTagMgr(c.data.image_attachment_filename)"
          ],
          [
            "div",
            "ng-if",
            "data.image_title != ''"
          ],
          [
            "div",
            "ng-if",
            "data.image_overlay == true"
          ],
          [
            "span",
            "ng-if",
            "data.image_attachment == ''"
          ],
          [
            "span",
            "ng-class",
            "{'image-fit': c.data.image_fit == 'fit'}"
          ],
          [
            "div",
            "ng-if",
            "data.image_title != ''"
          ],
          [
            "div",
            "ng-if",
            "data.image_overlay == true"
          ]
        ],
        "expressions": [
          "data.image_attachment",
          "data.image_src",
          "data.image_alt",
          "c.data.image_title",
          "data.image_src",
          "data.image_alt",
          "c.data.image_title"
        ],
        "active": []
      }
    },
    "cf3766131ba875107695a82fe54bcb0f": {
      "data_keys": [
        "carousels",
        "num_pages",
        "pageSize",
        "portal",
        "row_count"
      ],
      "code": {
        "client": "7430d57b2c4a96c3e74c30db1c616161dc3cfc501c3242a417b0b2fb53c7b372",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "div",
            "ng-if",
            "data.carousels.length != 0"
          ],
          [
            "div",
            "ng-repeat",
            "i in data.carousels | offset:c.currentPage*data.pageSize | limitTo:data.pageSize"
          ],
          [
            "a",
            "ng-disabled",
            "c.currentPage == 0"
          ],
          [
            "a",
            "ng-click",
            "c.currentPage=c.currentPage-1"
          ],
          [
            "span",
            "ng-if",
            "i.link==''"
          ],
          [
            "span",
            "ng-if",
            "i.link!=''"
          ],
          [
            "a",
            "ng-href",
            "{{i.link}}"
          ],
          [
            "a",
            "ng-class",
            "{disabled:c.currentPage==data.num_pages-1}"
          ],
          [
            "a",
            "ng-disabled",
            "c.currentPage==data.num_pages-1"
          ],
          [
            "a",
            "ng-click",
            "c.currentPage=c.currentPage+1"
          ]
        ],
        "expressions": [
          "i.title",
          "i.link",
          "i.title"
        ],
        "active": []
      }
    },
    "6914f1b61b8a5c107695a82fe54bcbb9": {
      "data_keys": [
        "background",
        "buttonHide",
        "email",
        "inAwardee",
        "page",
        "show_technical_help_request_popup",
        "technical_help_widget",
        "title",
        "visible"
      ]
    },
    "06cb6e981b9fc1507695a82fe54bcb40": {
      "data_keys": [
        "all_inputs_valid",
        "email",
        "error_message_email",
        "error_message_problem_desc",
        "form_input",
        "is_newselection",
        "is_popup",
        "is_selection",
        "issue_type",
        "issue_type_choices",
        "issuetype_input_valid",
        "parent_email_valid",
        "portal",
        "portal_choices",
        "portal_id",
        "portal_input_valid",
        "priority",
        "priority_choices",
        "priority_input_valid",
        "problem_description",
        "problem_first_name",
        "problem_last_name",
        "show_issuetype_choices",
        "show_portal_choices",
        "show_priority_choices",
        "show_tech_help_request_modal",
        "showcross",
        "submit_message",
        "submitted",
        "text_input_1_valid",
        "text_input_2_valid",
        "text_input_3_valid",
        "text_input_4_valid",
        "u_currently_minor",
        "u_parent_email"
      ]
    },
    "437c908a872a86105831a7530cbb3508": {
      "data_keys": [
        "eligibility_info",
        "loDiscipline",
        "pyYear",
        "pyYearOnlyPlusOne",
        "pyYearPlusOne",
        "scholars",
        "showApplyButton",
        "video_name",
        "video_url"
      ],
      "code": {
        "client": "3865dd980ccf10a78f9da9de80d886648e81213d5327c0ced7e57a0d92e56d36",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "li",
            "ng-repeat",
            "d in c.data.loDiscipline"
          ],
          [
            "a",
            "ng-click",
            "showContactUsModal()"
          ],
          [
            "a",
            "ng-if",
            "data.showApplyButton"
          ],
          [
            "sp-widget",
            "widget",
            "c.data.eligibility_info"
          ],
          [
            "a",
            "ng-click",
            "showContactUsModal()"
          ],
          [
            "div",
            "ng-repeat",
            "d in c.data.scholars"
          ],
          [
            "div",
            "ng-bind-html",
            "d.text"
          ],
          [
            "div",
            "ng-bind-html",
            "data.kbText"
          ]
        ],
        "expressions": [
          "d.name",
          "data.pyYearOnlyPlusOne",
          "data.pyYearOnlyPlusOne",
          "trustSrc(c.data.video_url)",
          "d.image",
          "d.alttext",
          "d.alttext",
          "d.name",
          "d.degree",
          "d.discipline",
          "data.kbName"
        ],
        "active": [
          "iframe"
        ]
      }
    },
    "7f5af26e87e28a105831a7530cbb35b8": {
      "data_keys": [
        "appClosed",
        "currentYear",
        "currentYearPlusOne",
        "currentYearPlusTwo",
        "pyYear",
        "pyYearPlusOne"
      ],
      "code": {
        "client": "173bcec10f1d2645e73a61e8a144beabf156ada7811481b34571b34a091fcfdc",
        "link": "7e8d5e6ead8be9d991d2798fd54b37f78e24b6347f68d79516262af513bc41ab"
      },
      "grammar": {
        "directives": [
          [
            "span",
            "ng-if",
            "!data.appClosed"
          ],
          [
            "span",
            "ng-if",
            "data.appClosed"
          ]
        ],
        "expressions": [
          "data.currentYear",
          "data.currentYear",
          "c.data.currentYearPlusTwo",
          "c.data.currentYearPlusOne",
          "c.data.currentYearPlusOne",
          "c.data.currentYearPlusOne"
        ],
        "active": []
      }
    }
  }
};

const REVIEWED_TYPES = {
  "69505de91bce90107695a82fe54bcbc1": {
    "showApply": "boolean",
    "connect_support_queue_id": "string",
    "login_page": "string",
    "showClosedWarning": "boolean",
    "profileBtnMsg": "string",
    "pyOpenNextYear": "string",
    "hasLogin": "boolean"
  },
  "5947caa91bfc94107695a82fe54bcb5f": {
    "showCountDown": "boolean"
  },
  "281b37e04f6e13004b5c30318110c74d": {
    "visible": "boolean",
    "deadLine": "number",
    "status": "string"
  },
  "6b86714a1b2dad507695a82fe54bcbac": {
    "showSelectionButton": "boolean",
    "showApplyButton": "boolean",
    "stipendText": "string",
    "showPanelistButton": "boolean",
    "showApply": "boolean",
    "universities": "number",
    "selectionLink": "string",
    "showClosedWarning": "boolean",
    "pyOpenNextYear": "string",
    "showPanelistRegButton": "boolean",
    "scholars": "number",
    "facilities": "number"
  },
  "c9795b2847b89210c205f9ee626d43f2": {
    "image_fit": "string",
    "image_attachment_filename": "string",
    "image_alt": "string",
    "description": "string",
    "image_attachment": "string",
    "image_title": "string",
    "title": "string",
    "image_src": "string",
    "image_overlay": "string",
    "background": "string",
    "image_location": "string"
  },
  "dda3e7808762fe105831a7530cbb3596": {
    "image_fit": "string",
    "image_overlay": "string",
    "image_attachment_filename": "string",
    "image_alt": "string",
    "image_attachment": "string",
    "image_title": "string",
    "image_src": "string"
  },
  "cf3766131ba875107695a82fe54bcb0f": {
    "num_pages": "number",
    "pageSize": "number",
    "portal": "string",
    "row_count": "number"
  },
  "437c908a872a86105831a7530cbb3508": {
    "video_name": "string",
    "video_url": "string",
    "pyYearOnlyPlusOne": "string",
    "pyYear": "string",
    "showApplyButton": "boolean",
    "pyYearPlusOne": "string"
  },
  "7f5af26e87e28a105831a7530cbb35b8": {
    "currentYearPlusOne": "number",
    "pyYear": "string",
    "pyYearPlusOne": "string",
    "currentYearPlusTwo": "number",
    "appClosed": "boolean",
    "currentYear": "string"
  }
};

const REVIEWED_HTML = {
  "69505de91bce90107695a82fe54bcbc1": {
    "tags": [
      "a",
      "button",
      "div",
      "i",
      "img",
      "li",
      "nav",
      "noscript",
      "script",
      "sn-avatar",
      "sp-widget",
      "span",
      "ul"
    ],
    "attributes": [
      "a:aria-expanded",
      "a:class",
      "a:data-toggle",
      "a:href",
      "a:id",
      "a:ng-click",
      "a:ng-href",
      "a:role",
      "a:target",
      "a:title",
      "button:class",
      "button:data-target",
      "button:data-toggle",
      "button:type",
      "div:align",
      "div:aria-expanded",
      "div:class",
      "div:ng-if",
      "i:aria-hidden",
      "i:class",
      "img:alt",
      "img:border",
      "img:class",
      "img:height",
      "img:role",
      "img:src",
      "img:style",
      "img:width",
      "li:class",
      "li:ng-if",
      "nav:role",
      "script:type",
      "sn-avatar:class",
      "sn-avatar:primary",
      "sp-widget:ng-if",
      "sp-widget:widget",
      "span:class",
      "ul:aria-haspopup",
      "ul:class",
      "ul:data-toggle",
      "ul:ng-if",
      "ul:role"
    ]
  },
  "5947caa91bfc94107695a82fe54bcb5f": {
    "tags": [
      "div",
      "sp-widget"
    ],
    "attributes": [
      "div:ng-show",
      "sp-widget:widget"
    ]
  },
  "281b37e04f6e13004b5c30318110c74d": {
    "tags": [
      "div",
      "span"
    ],
    "attributes": [
      "div:class",
      "span:class",
      "span:id"
    ]
  },
  "6b86714a1b2dad507695a82fe54bcbac": {
    "tags": [
      "a",
      "br",
      "div",
      "h1",
      "h2",
      "hr",
      "sp-widget",
      "span"
    ],
    "attributes": [
      "a:href",
      "a:ng-if",
      "div:aria-label",
      "div:class",
      "div:data-placement",
      "div:data-toggle",
      "div:ng-if",
      "div:role",
      "div:title",
      "h1:class",
      "sp-widget:widget",
      "span:class"
    ]
  },
  "c9795b2847b89210c205f9ee626d43f2": {
    "tags": [
      "a",
      "div",
      "h2",
      "img",
      "sp-widget",
      "span"
    ],
    "attributes": [
      "a:ng-href",
      "a:ng-repeat",
      "div:class",
      "div:ng-bind-html",
      "div:ng-class",
      "div:ng-if",
      "div:ng-repeat",
      "img:alt",
      "img:ng-src",
      "sp-widget:widget",
      "span:class"
    ]
  },
  "dda3e7808762fe105831a7530cbb3596": {
    "tags": [
      "a",
      "div",
      "i",
      "img",
      "span"
    ],
    "attributes": [
      "a:href",
      "a:ng-class",
      "a:ng-click",
      "a:ng-if",
      "a:target",
      "div:class",
      "div:ng-if",
      "i:aria-hidden",
      "i:class",
      "i:height",
      "i:style",
      "i:width",
      "img:alt",
      "img:src",
      "span:ng-class",
      "span:ng-if"
    ]
  },
  "cf3766131ba875107695a82fe54bcb0f": {
    "tags": [
      "a",
      "div",
      "i",
      "span"
    ],
    "attributes": [
      "a:class",
      "a:ng-class",
      "a:ng-click",
      "a:ng-disabled",
      "a:ng-href",
      "a:target",
      "div:class",
      "div:ng-if",
      "div:ng-repeat",
      "i:aria-hidden",
      "i:class",
      "span:class",
      "span:ng-if"
    ]
  },
  "437c908a872a86105831a7530cbb3508": {
    "tags": [
      "a",
      "br",
      "button",
      "div",
      "h2",
      "h3",
      "i",
      "iframe",
      "img",
      "li",
      "p",
      "sp-widget",
      "span",
      "ul"
    ],
    "attributes": [
      "a:class",
      "a:href",
      "a:ng-click",
      "a:ng-if",
      "button:aria-controls",
      "button:aria-expanded",
      "button:class",
      "button:data-target",
      "button:data-toggle",
      "button:type",
      "div:aria-label",
      "div:aria-labelledby",
      "div:class",
      "div:data-parent",
      "div:id",
      "div:ng-bind-html",
      "div:ng-repeat",
      "div:role",
      "div:style",
      "h2:class",
      "h3:class",
      "i:class",
      "iframe:allow",
      "iframe:allowfullscreen",
      "iframe:class",
      "iframe:frameborder",
      "iframe:height",
      "iframe:max-width",
      "iframe:referrerpolicy",
      "iframe:src",
      "iframe:title",
      "iframe:width",
      "img:alt",
      "img:class",
      "img:height",
      "img:src",
      "img:title",
      "img:width",
      "li:ng-repeat",
      "p:class",
      "p:style",
      "sp-widget:widget",
      "span:class"
    ]
  },
  "7f5af26e87e28a105831a7530cbb35b8": {
    "tags": [
      "div",
      "h2",
      "li",
      "span",
      "ul"
    ],
    "attributes": [
      "div:class",
      "h2:class",
      "span:class",
      "span:ng-if",
      "ul:class",
      "ul:style"
    ]
  }
};
const REVIEWED_LAYOUT = {
  "home": "f326a89987d7582e49a83ae4e6223360b1fc0f67ebd415373d9fb1f217234a4b",
  "eligibility": "5ffe810570a65ede9a075341a25b42ebdd0075c99764e3c490d5f4580153d404"
};
const canonical = x => Array.isArray(x) ? x.map(canonical) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, canonical(x[key])])) : x;
function layoutIdentity(x) {
  if (!x || typeof x !== "object") return x;
  if (typeof x.client_script === "string" && typeof x.template === "string") return { $widget: x.sys_id };
  return Array.isArray(x) ? x.map(layoutIdentity) : Object.fromEntries(Object.entries(x).map(([key, value]) => [key, layoutIdentity(value)]));
}

function getAt(document, pointer) {
  return pointer.split("/").slice(1).reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}
function modelWidgets(document, profile) {
  const rows = [], walk = (x, pointer) => {
    if (!x || typeof x !== "object") return;
    if (typeof x.client_script === "string" || x.sys_class_name === "sp_widget") {
      check(plain(x) && typeof x.template === "string" && typeof x.client_script === "string" && plain(x.data), "widget_shape");
      rows.push({ widget: x, pointer });
    }
    for (const [key, value] of Object.entries(x)) if (key !== "user") walk(value, pointer + "/" + pointerKey(key));
  };
  walk(document.result, "/result");
  const expected = REVIEWED_MODEL.profiles[profile.key];
  check(rows.length === expected.length, "widget_graph");
  for (const row of rows) {
    check(expected.some(x => x.pointer === row.pointer && x.id === row.widget.sys_id), "widget_graph");
    const w = row.widget;
    check(w.public === true && w.roles === "" && (w.async_load === undefined || w.async_load === false) &&
      (w.options?.async_load === undefined || w.options.async_load === false) && (w.async_load === false || w.options?.async_load === false), "private_or_async_widget");
    const rule = REVIEWED_MODEL.widgets[w.sys_id];
    check(rule, "unknown_widget");
    check(equal(Object.keys(w.data).sort(), rule.data_keys) || rule.optional_sections && equal(Object.keys(w.data).filter(k => k !== "sections").sort(), rule.data_keys), "widget_data_fields");
    if (rule.code) check(hash(w.client_script) === rule.code.client && (w.link ? hash(w.link) : null) === rule.code.link, "programme_controller_changed");
    for (const [key, type] of Object.entries(REVIEWED_TYPES[w.sys_id] || {})) {
      check(typeof w.data[key] === type && (type !== "string" || textValue(w.data[key])) && (type !== "number" || Number.isFinite(w.data[key])), "programme_field_type");
    }
    if (w.sys_id === "c9795b2847b89210c205f9ee626d43f2") {
      check(["left", "right"].includes(w.data.image_location) && Array.isArray(w.data.buttons) && w.data.buttons.length <= 200, "programme_buttons_missing");
      check(!Object.hasOwn(w.data, "sections") || Array.isArray(w.data.sections) && w.data.sections.length === 0, "unreviewed_programme_sections");
      for (const button of w.data.buttons) check(plain(button) && equal(Object.keys(button).sort(), ["active", "href", "title"]) && typeof button.active === "boolean" && textValue(button.href, 10000) && textValue(button.title, 1000), "programme_button_shape");
    }
    const $ = load(w.template, { sourceCodeLocationInfo: true }, false), directives = [];
    $("*").each((_, el) => { for (const [key, value] of Object.entries(el.attribs || {})) if (key.startsWith("ng-") || key === "widget") directives.push([el.name, key, value]); });
    const expressions = [...w.template.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(m => m[1].trim());
    if (rule.grammar) {
      check(equal(directives, rule.grammar.directives) && equal(expressions, rule.grammar.expressions), "programme_binding_changed");
      const active = [];
      $("*").each((_, el) => {
        check(REVIEWED_HTML[w.sys_id].tags.includes(el.name) && Object.keys(el.attribs || {}).every(key => REVIEWED_HTML[w.sys_id].attributes.includes(el.name + ":" + key)), "unreviewed_programme_markup");
        if (["script", "iframe", "object", "embed"].includes(el.name)) active.push(el.name);
        check(!Object.keys(el.attribs || {}).some(k => /^on/i.test(k)), "unreviewed_inline_code");
      });
      check(equal(active, rule.grammar.active), "programme_active_content_changed");
    }
    row.fragment = $;
  }
  return rows;
}

/** Project only the reviewed programme-rule model. Whole original JSON remains
 * the caller's private raw evidence. This does NOT assert HTML/WS completeness. */
export function projectSmartPublisherJson(raw, { source } = {}) {
  if ([...SMART_KB_PUBLISHER_SOURCE_PROFILES, ...SMART_GUIDE_KB_SOURCE_PROFILES].some(profile => profile.id === source?.id)) return projectSmartKbPublisherJson(raw, { source });
  const profile = SMART_PUBLISHER_JSON_SOURCE_PROFILES.find(p => source?.id === p.id);
  check(profile && source.shared_award_id === profile.shared_award_id && source.url === profile.url, "source_identity");
  if (profile.id === "92eebc07-7392-4136-ba13-d9cd5455c8f9") check(source.page_type === "homepage", "source_identity");
  const parsed = parseOriginal(raw), document = parsed.document, result = document?.result;
  check(plain(document) && equal(Object.keys(document), ["result"]) && plain(result), "result_shape");
  check(equal(Object.keys(result).sort(), ["$$uiNotification", "announcements", "containers", "metatags", "page", "seotags", "theme", "user"].sort()), "result_fields");
  const page = result.page;
  check(plain(page) && page.id === profile.page_id && page.sys_id === profile.page_sys_id && page.public === true && page.draft === false && page.internal === false, "page_identity");
  check(profile.key === "home" ? page.u_portal === PORTAL : page.u_portal === undefined || page.u_portal === PORTAL, "portal_identity");
  check(plain(result.user) && equal(Object.keys(result.user).sort(), ["can_debug", "can_debug_admin", "logged_in"]) &&
    result.user.logged_in === false && result.user.can_debug === false && result.user.can_debug_admin === false, "anonymous_required");
  check(result.theme?.footer?.data?.portal === "smart" && result.theme.header?.data?.loginWidget?.data?.pageURI === new URL(profile.url).pathname + new URL(profile.url).search, "portal_route_identity");
  check(Array.isArray(result.containers) && result.containers.length === 1 && Array.isArray(result.announcements) && !result.announcements.length && Array.isArray(result.$$uiNotification) && !result.$$uiNotification.length, "unreviewed_page_content");
  const rows = modelWidgets(document, profile), byPointer = new Map(rows.map(row => [row.pointer, row]));
  check(hash(JSON.stringify(canonical(layoutIdentity(result.containers)))) === REVIEWED_LAYOUT[profile.key], "layout_changed");
  const root = getAt(document, profile.programme_pointer);
  check(root && textValue(page.title, 500) && page.title.trim(), "programme_missing");
  const announcements = result.theme.header.data.announcementWidget?.data;
  check(announcements && Array.isArray(announcements.informationAnnouncements) && !announcements.informationAnnouncements.length &&
    Array.isArray(announcements.outages) && !announcements.outages.length && announcements.informationAnnouncementIDs === "" && announcements.outageIDs === "", "unreviewed_announcements");
  const exclusions = [], blocks = [], fields = [], source_links = [], blockSources = [];
  let text = "", current = [], supports = [], heading = page.title, currentKind = "paragraph";
  const exclude = (pointer, reason) => { const value = getAt(document, pointer); check(value !== undefined, "excluded_scope_missing"); exclusions.push({ pointer, reason, count: Array.isArray(value) ? value.length : 1, content_sha256: hash(JSON.stringify(value)) }); };
  function flush(kind = currentKind) {
    const value = norm(current.join("")); current = [];
    const sources = supports; supports = [];
    if (!value) return;
    check(value.length <= 20000 && blocks.length < 2000, "projection_limit");
    if (text) text += "\n\n"; const start_utf16 = text.length; text += value;
    const unique = [...new Map(sources.map(s => [JSON.stringify(s), s])).values()]; check(unique.length <= 128, "provenance_limit");
    const id = `block-${String(blocks.length).padStart(6, "0")}`;
    const context = { schema: SMART_PUBLISHER_JSON_SCHEMA, representation: "publisher_text", verbatim: true, sources: unique };
    blocks.push({ id, text: value, start_utf16, end_utf16: text.length, heading, page: null, kind, context });
    blockSources.push({ id, sources: unique });
  }
  function add(value, sourceInfo) { check(textValue(value), "invalid_programme_text"); current.push(value); supports.push(sourceInfo); }
  function member(expression, model) {
    expression = expression.trim();
    const number = expression.match(/^(.+?)\s*\|\s*number$/);
    if (number) { const found = member(number[1], model); check(typeof found.value === "number" && Number.isFinite(found.value), "invalid_number_binding"); return { ...found, value: new Intl.NumberFormat("en-US").format(found.value) }; }
    check(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression), "unknown_expression");
    const keys = expression.split("."), first = model[keys.shift()]; check(first, "unknown_expression");
    let value = first.value, pointer = first.pointer;
    for (const key of keys) { check(plain(value) && Object.hasOwn(value, key), "missing_binding"); value = value[key]; pointer += "/" + pointerKey(key); }
    return { value, pointer };
  }
  function substitute(value, model) {
    const sources = [];
    const output = value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => { const item = member(expression, model); check(["string", "number", "boolean"].includes(typeof item.value), "nonscalar_binding"); sources.push({ pointer: item.pointer, operation: "scalar_substitution" }); return String(item.value); });
    check(!output.includes("{{") && !output.includes("}}"), "unresolved_binding"); return { output, sources };
  }
  function condition(expression, model) {
    let match = expression.match(/^((?:c\.)?data\.[\w]+) == '(left|right)'$/);
    if (match) return member(match[1], model).value === match[2];
    const negative = expression.startsWith("!");
    const item = member(negative ? expression.slice(1) : expression, model);
    check(typeof item.value === "boolean" || plain(item.value), "nonboolean_condition");
    return negative ? !item.value : !!item.value;
  }
  const breakTags = new Set(["div", "section", "article", "p", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "br"]);
  const literalTags = new Set(["div", "section", "article", "p", "span", "strong", "em", "b", "i", "u", "s", "sup", "sub", "ul", "ol", "li", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "a"]);
  const nodeText = node => node.type === "text" ? node.data : (node.children || []).map(nodeText).join("");
  function renderWidget(pointer, depth = 0) {
    check(depth < 12, "projection_depth"); const row = byPointer.get(pointer); check(row, "unbound_widget");
    if (row.widget.sys_id === "dda3e7808762fe105831a7530cbb3596") { check(row.widget.data.image_title === "", "unreviewed_image_caption"); exclude(pointer, "reviewed_illustrative_image"); return; }
    flush(); const model = { data: { value: row.widget.data, pointer: pointer + "/data" }, c: { value: { data: row.widget.data }, pointer } };
    // c.data is an alias for the same exact publisher object, not a new scope.
    model.c.pointer = pointer;
    const nodes = row.fragment.root().contents().toArray();
    if (profile.key === "home" && pointer === HOME) {
      for (const node of nodes) {
        if (node.type === "text" && !node.data.trim()) continue;
        if (node.type === "tag" && node.name === "div" && ["benefits-container", "front"].includes(node.attribs?.class)) renderNode(node, model, pointer + "/template", depth);
        else if (node.attribs?.widget === "c.data.program_and_eligibility" || node.attribs?.widget === "c.data.future_leaders") renderNode(node, model, pointer + "/template", depth);
        else if (node.type !== "comment") {
          // Known sibling sections are accounted explicitly, never summarized as rules.
          check(node.attribs?.class === "front" || node.attribs?.class === "number-container" || node.attribs?.widget === "c.data.scholar_recipients" || node.attribs?.["ng-if"] === "c.data.smart_carousel", "unknown_home_section");
        }
      }
    } else for (const node of nodes) renderNode(node, model, pointer + "/template", depth);
    flush();
  }
  function renderNode(node, model, templatePointer, depth, noRepeat = false) {
    check(depth <= 64, "projection_depth");
    if (node.type === "comment") return;
    if (node.type === "text") { const value = substitute(node.data, model); add(value.output, { pointer: templatePointer, operation: "template_text", ...(node.sourceCodeLocation ? { decoded_start_utf16: node.sourceCodeLocation.startOffset, decoded_end_utf16: node.sourceCodeLocation.endOffset } : {}) }); supports.push(...value.sources); return; }
    if (!["tag", "script", "style"].includes(node.type)) return;
    const attrs = node.attribs || {}, repeat = attrs["ng-repeat"];
    if (profile.key === "eligibility" && templatePointer === ELIGIBILITY + "/template" &&
      ((attrs.class || "").split(/\s+/).includes("scholar-container") || node.name === "a" && attrs.href === "/smart/en?id=smart_videos")) return;
    if (repeat && !noRepeat) {
      const match = repeat.match(/^([a-z][A-Za-z]*) in ((?:c\.)?data\.[\w]+)$/); check(match, "unknown_loop");
      if (match[2] === "c.data.scholars") return; // Explicit exclusion below.
      let item;
      if (match[2] === "data.sections" && !Object.hasOwn(model.data.value, "sections")) return;
      item = member(match[2], model); check(Array.isArray(item.value) && item.value.length <= 200, "invalid_loop");
      for (let i = 0; i < item.value.length; i++) renderNode(node, { ...model, [match[1]]: { value: item.value[i], pointer: item.pointer + "/" + i } }, templatePointer, depth, true);
      return;
    }
    if (attrs["ng-if"] && !condition(attrs["ng-if"], model)) return;
    if (attrs.widget) { const item = member(attrs.widget, model); check(plain(item.value), "missing_widget_binding"); renderWidget(item.pointer, depth + 1); return; }
    if (["script", "style", "noscript", "iframe", "video", "source", "img"].includes(node.name)) return;
    // Initially absent contact-modal fields are NOT programme evidence. A new
    // populated modal is held rather than silently discarded as harmless UI.
    if (attrs["ng-bind-html"] === "data.kbText") { check(!Object.hasOwn(model.data.value, "kbText") || model.data.value.kbText === "", "unreviewed_contact_content"); return; }
    if (node.type === "tag" && node.children?.some(child => child.type === "text" && child.data.includes("{{data.kbName}}"))) { check(!Object.hasOwn(model.data.value, "kbName") || model.data.value.kbName === "", "unreviewed_contact_content"); return; }
    if (breakTags.has(node.name)) flush();
    const oldKind = currentKind;
    if (/^h[1-6]$/.test(node.name)) currentKind = "heading";
    else if (node.name === "li") currentKind = "li";
    if (node.name === "a" && (attrs.href || attrs["ng-href"])) {
      const literal = attrs["ng-href"] || attrs.href, link = substitute(literal, model);
      const label = norm(nodeText(node));
      const contactAction = link.output === "javascript:void(0)" && attrs["ng-click"] === "showContactUsModal()";
      if (!link.output.startsWith("#") && !contactAction) {
        let url; try { url = new URL(link.output, new URL(profile.expected_base_href, profile.url)); } catch { fail("invalid_source_link"); }
        check(["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password, "invalid_source_link");
        source_links.push({ raw_href: link.output, resolved_url: url.href, text: substitute(label, model).output, pointer: templatePointer, sources: link.sources });
      }
    }
    if (attrs["ng-bind-html"]) {
      const item = member(attrs["ng-bind-html"], model); check(textValue(item.value), "invalid_html_binding");
      const fragment = load(item.value, { sourceCodeLocationInfo: true }, false);
      check(!fragment("[widget]").length && !fragment("*").toArray().some(el => !literalTags.has(el.name) || Object.keys(el.attribs || {}).some(k => k.startsWith("ng-") || k.startsWith("on"))) && !item.value.includes("{{"), "dynamic_data_html");
      for (const child of fragment.root().contents().toArray()) renderNode(child, model, item.pointer, depth + 1);
    } else for (const child of node.children || []) renderNode(child, model, templatePointer, depth + 1);
    if (breakTags.has(node.name)) { flush(); if (currentKind === "heading" && blocks.length) heading = blocks.at(-1).text; }
    currentKind = oldKind;
  }

  add(page.title, { pointer: "/result/page/title", operation: "literal" }); flush("heading");
  // Explicitly audited exclusions remain privately hash-accounted in full.
  for (const pointer of ["/result/user", "/result/theme/footer", "/result/theme/header/data/loginWidget", "/result/theme/header/data/menu", "/result/theme/header/data/announcementWidget", "/result/metatags", "/result/seotags"]) exclude(pointer, "non_programme_UI_or_metadata");
  if (profile.key === "home") {
    check(root.data.smart_carousel.data.row_count === 0 && root.data.smart_carousel.data.num_pages === 0 && Array.isArray(root.data.smart_carousel.data.carousels) && root.data.smart_carousel.data.carousels.length === 0, "unreviewed_carousel_pages");
    for (const pointer of [HOME + "/data/scholar_recipients", HOME + "/data/smart_carousel"]) exclude(pointer, "reviewed_marketing_or_empty_carousel");
    for (const key of ["universities", "scholars", "facilities"]) exclude(HOME + "/data/" + key, "marketing_metric");
    exclude(HOME + "/data/pyOpenNextYear", "unused_home_reopen_value");
    const metrics = byPointer.get(HOME).fragment(".number-container");
    check(metrics.length === 1, "marketing_section_shape");
    exclusions.push({ pointer: HOME + "/template", selector: ".number-container", reason: "complete_separately_structured_marketing_metrics", count: 1, content_sha256: hash(metrics.toString()) });
  } else {
    check(Array.isArray(root.data.scholars) && root.data.scholars.length === 4, "unreviewed_testimonial_scope");
    exclude(ELIGIBILITY + "/data/scholars", "complete_reviewed_testimonial_array_not_programme_rules");
    const fragment = byPointer.get(ELIGIBILITY).fragment;
    for (const selector of [".scholar-container", 'a[href="/smart/en?id=smart_videos"]']) {
      const scope = fragment(selector); check(scope.length === 1, "testimonial_section_shape");
      exclusions.push({ pointer: ELIGIBILITY + "/template", selector, reason: "reviewed_testimonial_heading_or_video_promotion", count: 1, content_sha256: hash(scope.toString()) });
    }
    exclude("/result/containers/0/rows/0/columns/0/widgets/0/widget/data/technical_help_widget", "technical_support_form");
    exclude(ELIGIBILITY + "/data/video_url", "linked_video_not_observed_or_rule_authority");
    exclude(ELIGIBILITY + "/data/video_name", "linked_video_title");
    check(Array.isArray(root.data.loDiscipline) && root.data.loDiscipline.length > 0 && root.data.loDiscipline.length <= 200, "discipline_array_missing");
    for (const discipline of root.data.loDiscipline) check(plain(discipline) && equal(Object.keys(discipline).sort(), ["name", "sysID", "value"]) && Object.values(discipline).every(value => textValue(value, 1000) && value), "discipline_shape");
  }
  renderWidget(profile.programme_pointer);
  const header = result.theme.header.data, countdown = header.wCountdown?.data?.countDownWidget?.data;
  check(typeof header.showApply === "boolean" && typeof header.showClosedWarning === "boolean" && typeof root.data.showApplyButton === "boolean", "status_fields_missing");
  if (header.showClosedWarning) {
    check(textValue(header.pyOpenNextYear, 300) && header.pyOpenNextYear, "reopen_value_missing");
    const row = byPointer.get("/result/theme/header"), node = row.fragment('[ng-if="data.showClosedWarning"]');
    check(node.length === 1, "closure_template_missing");
    renderNode(node.get(0), { data: { value: header, pointer: "/result/theme/header/data" } }, "/result/theme/header/template", 0); flush();
  } else {
    exclude("/result/theme/header/data/pyOpenNextYear", "inactive_reopen_value");
  }
  function dataField(pointer, semantic) {
    const value = getAt(document, pointer), span = parsed.spans.get(pointer);
    check(span && ["boolean", "string", "number"].includes(typeof value), "publisher_field_missing");
    const raw_value = parsed.input.slice(span.start_utf16, span.end_utf16), field = { pointer, semantic, value, raw_value };
    fields.push(field); if (text) text += "\n\n"; const start_utf16 = text.length;
    const valueText = `Publisher data (not a source quotation): ${pointer} = ${raw_value}`; text += valueText;
    blocks.push({ id: `block-${String(blocks.length).padStart(6, "0")}`, text: valueText, start_utf16, end_utf16: text.length, heading: "Publisher data as of response", page: null, kind: "publisher_data",
      context: { schema: SMART_PUBLISHER_DATA_SCHEMA, representation: "publisher_data", verbatim: false, pointer, semantic, value, raw_value } });
  }
  dataField("/result/theme/header/data/showApply", "publisher_show_apply");
  dataField("/result/theme/header/data/showClosedWarning", "publisher_show_closed_warning");
  dataField(profile.programme_pointer + "/data/showApplyButton", "publisher_show_apply_button");
  if (profile.key === "home") {
    dataField(HOME + "/data/showApply", "publisher_home_show_apply");
    dataField(HOME + "/data/showClosedWarning", "publisher_home_show_closed_warning");
  }
  check(header.wCountdown?.data?.showCountDown === true || header.wCountdown?.data?.showCountDown === false, "countdown_visibility_missing");
  check(countdown && typeof countdown.visible === "boolean", "countdown_missing");
  dataField("/result/theme/header/data/wCountdown/data/showCountDown", "publisher_countdown_displayed");
  dataField("/result/theme/header/data/wCountdown/data/countDownWidget/data/visible", "publisher_countdown_visible");
  check(Number.isSafeInteger(countdown.deadLine) && countdown.deadLine > 0 && countdown.deadLine <= 8640000000000000 && ["Closes", "Opens"].includes(countdown.status), "deadline_status_invalid");
  dataField("/result/theme/header/data/wCountdown/data/countDownWidget/data/deadLine", "publisher_deadline_epoch_ms");
  dataField("/result/theme/header/data/wCountdown/data/countDownWidget/data/status", "publisher_countdown_status");
  // Link destinations can change with stable labels. Keep these as explicitly
  // non-verbatim source attributes in the monitored document.
  for (let i = 0; i < source_links.length; i++) {
    const link = source_links[i]; if (text) text += "\n\n"; const start_utf16 = text.length; text += link.raw_href;
    blocks.push({ id: `source-link-${String(i).padStart(6, "0")}`, text: link.raw_href, start_utf16, end_utf16: text.length, heading: link.text, page: null, kind: "source_link",
      context: { schema: SMART_PUBLISHER_JSON_SCHEMA, representation: "publisher_attribute", verbatim: false, pointer: link.pointer, source_attribute: "href", link_text: link.text,
        base_hrefs: [profile.expected_base_href], base_url: new URL(profile.expected_base_href, profile.url).href, navigation_source_url: profile.url,
        source_representation: "publisher_json", resolved_url: link.resolved_url, sources: link.sources } });
  }
  check(text.length <= 500000 && blocks.length <= 2000 && blocks.length > fields.length, "projection_limit");
  return { text, blocks, fields, source_links, provenance: { schema: SMART_PUBLISHER_JSON_SCHEMA, version: PROJECTOR_VERSION, representation: "publisher_json", source_id: profile.id,
    raw_sha256: hash(parsed.bytes), raw_byte_length: parsed.bytes.length, page_id: page.id, page_sys_id: page.sys_id,
    expected_portal_id: PORTAL, portal_id_published_in_page: page.u_portal ?? null, expected_base_href: profile.expected_base_href, transport_binding_required: true,
    programme_widget_pointer: profile.programme_pointer, widget_count: rows.length, blocks: blockSources, exclusions,
    semantic_scope: "Initial complete reviewed programme-rule model only; no claim of HTML completeness, callback execution, push refresh or factual approval." } };
}
