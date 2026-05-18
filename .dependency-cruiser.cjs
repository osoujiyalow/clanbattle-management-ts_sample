module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {
        path: "^src",
      },
      to: {
        circular: true,
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: "^dist",
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};
