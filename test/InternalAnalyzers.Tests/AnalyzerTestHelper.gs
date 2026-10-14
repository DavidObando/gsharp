// <copyright file="AnalyzerTestHelper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

internal shared class AnalyzerTestHelper {
    func AssertDiagnosticsAsync(analyzer GSharpDiagnosticAnalyzer, source string, diagnosticIds ...string) Task {
        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, source, diagnosticIds)
        return Task.CompletedTask
    }
}
