import { compileTemplates } from "../src/compiler.js";
const templates = {
  "page.html":
    '<script type="application/json">{{#include "data.html"}}</script>',
  "data.html": "{{payload}}",
};
const program = compileTemplates(templates, "page.html", {
  allowJsonData: true,
});
console.log(
  program.render({
    payload: { title: "<sample>", enabled: false, count: 0, list: [null, 1] },
  }),
);
