// <copyright file="GsfmtIgnoreTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Gsfmt;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class GsfmtIgnoreTests
{
    [Fact]
    public void IsIgnored_UsesNearestAncestorRulesAndGeneratedExclusion()
    {
        string root = Path.Combine(Path.GetTempPath(), "gsfmt-ignore-" + Guid.NewGuid().ToString("N"));
        string ignored = Path.Combine(root, "generated", "nested", "Ignored.gs");
        string included = Path.Combine(root, "generated", "Keep.gs");
        string generated = Path.Combine(root, "Generated.g.gs");
        Directory.CreateDirectory(Path.GetDirectoryName(ignored)!);
        File.WriteAllText(Path.Combine(root, ".gsfmtignore"), "generated/**\n!generated/Keep.gs\n");
        File.WriteAllText(ignored, string.Empty);
        File.WriteAllText(included, string.Empty);
        File.WriteAllText(generated, string.Empty);

        try
        {
            Assert.True(IgnoreMatcher.IsIgnored(ignored));
            Assert.False(IgnoreMatcher.IsIgnored(included));
            Assert.True(IgnoreMatcher.IsIgnored(generated));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
