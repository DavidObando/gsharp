// <copyright file="Issue3785MixedInitializerEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue3785MixedInitializerEmittedOracleTests {
    @Fact
    func MixedMembersAndSpreads_MatchCompiledLexicalOrder() -> AssertOutput(
        Issue3785MixedInitializerCases.LexicalOrder,
        Issue3785MixedInitializerCases.LexicalOrderOutput
    )

    @Fact
    func ExplicitMembersAndUnmarkedKeys_KeepDistinctOperations() -> AssertOutput(
        Issue3785MixedInitializerCases.DistinctMemberAndKey,
        Issue3785MixedInitializerCases.DistinctMemberAndKeyOutput
    )

    shared {
        private func AssertOutput(source string, expected string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.True(
                !result.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.ToString())
                )
            )
            Assert.Null(result.UnhandledException)
            Assert.Equal(expected, result.Output.ReplaceLineEndings(Environment.NewLine))
        }
    }
}
