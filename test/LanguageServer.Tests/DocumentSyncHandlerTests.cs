// <copyright file="DocumentSyncHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DocumentSyncHandlerTests
{
    [Fact]
    public void ComputeDiagnostics_IncludesBindingDiagnosticsWhenRequested()
    {
        const string source = "func F() int32 {\n}\n";

        var fastDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: true).Diagnostics;
        var fullDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: false).Diagnostics;

        Assert.DoesNotContain(fastDiagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));
        Assert.Contains(fullDiagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));
    }
}
