// <copyright file="Issue3501VariantMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 Track A5: generic inference accepts VARIANT method-group
/// candidates — a method may take a broader parameter type than the target
/// delegate (contravariance) and return a narrower one (covariance), exactly
/// as C# method-group conversions permit. Method-group arguments contribute
/// only output-type inference: their natural function type no longer
/// hard-unifies the delegate's parameter slots. Explicit type arguments
/// already accepted these groups; inference now matches.
/// </summary>
public class Issue3501VariantMethodGroupTests
{
    [Fact]
    public void ContravariantParameter_UnderInference_BindsAndRuns()
    {
        var source = @"
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Stringify(value object?) string -> value?.ToString() ?? ""<nil>""

        func Run() string {
            let paths = List[string]{ ""a"", ""b"" }
            return string.Join("","", paths.Select(Stringify))
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("a,b", result.Value);
    }

    [Fact]
    public void ContravariantParameter_InPredicateSlot_BindsAndRuns()
    {
        var source = @"
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func IsShort(value object?) bool -> value?.ToString()?.Length < 2

        func Run() int32 {
            let paths = List[string]{ ""a"", ""bb"", ""c"" }
            return paths.Where(IsShort).Count()
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void CovariantReturn_IntoFixedDelegateSlot_BindsAndRuns()
    {
        var source = @"
class W {
    shared {
        func Twice(s string) string -> s + s

        func Apply(f (string) -> object) object -> f(""q"")

        func Run() string -> Apply(Twice).ToString() ?? """"
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("qq", result.Value);
    }

    [Fact]
    public void ExactCandidate_StillPreferredOverVariant()
    {
        var source = @"
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Mark(value object?) string -> ""object""

        func Mark(value string) string -> ""string""

        func Run() string {
            let paths = List[string]{ ""a"" }
            return paths.Select(Mark).First()
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("string", result.Value);
    }

    [Fact]
    public void IncompatibleGroup_StillReportsResolutionFailure()
    {
        var source = @"
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Weigh(value int32) string -> value.ToString()

        func Run() string {
            let paths = List[string]{ ""a"" }
            return paths.Select(Weigh).First()
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }
}
