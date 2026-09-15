// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4219GenericLocalRecursionTests
{
    [Theory]
    [InlineData("static ")]
    [InlineData("")]
    public void ConstructedGenericCycle_PreservesExplicitInferredAndChangedArguments(string modifier)
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit($$"""
            namespace Demo {
                public class C {
                    public string Run() {
                        return First<int, string>(42, "x", 3) + "|" + First("y", 7, 2);
                        {{modifier}}string First<T, U>(T a, U b, int n) {
                            return n == 0 ? a.ToString() + ":" + b.ToString() : Second<U, T>(b, a, n - 1);
                        }
                        {{modifier}}string Second<X, Y>(X a, Y b, int n) { return Third(a, b, n); }
                        {{modifier}}string Third<A, B>(A a, B b, int n) { return First<A, B>(a, b, n); }
                    }
                }
            }
            """);
        Assert.Contains("__local_Run_First", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Run_Second", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Run_Third", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "x:42|y:7");
    }

    [Fact]
    public void GenericMemberWithNonGenericSubcycle_KeepsEntireCycleOffNullableScheme()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run() {
                        return First(3);
                        static int First(int n) { return n == 0 ? 0 : Second(n - 1) + Third<int>(n - 1); }
                        static int Second(int n) { return First(n); }
                        static int Third<T>(int n) { return First(n); }
                    }
                }
            }
            """);
        Assert.DoesNotContain("var First", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var Second", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Run_Third", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "0");
    }

    [Fact]
    public void GenericCycle_KeepsDefaultAndNamedArgumentEvaluationOrder()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class C {
                    public int Run() {
                        return First<int>(n: Mark(2), value: Mark(7));
                        static int Mark(int value) { System.Console.Write(value); return value; }
                        static int First<T>(T value, int n = 0) {
                            return n == 0 ? 19 : Second<T>(value: value, n: n - 1);
                        }
                        static int Second<U>(U value, int n = 0) { return First<U>(value, n); }
                    }
                }
            }
            """);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "2719");
    }

    [Fact]
    public void SignaturePreparationContinuations_RoundTripThroughNativeCallableValues()
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit("""
            namespace Demo {
                public class Body { public int Value => 42; }
                public class C {
                    public int Run() {
                        System.Func<System.Func<Body>> prepare = () => () => new Body();
                        var bodies = new System.Collections.Generic.List<System.Func<Body>>();
                        bodies.Add(prepare());
                        var result = 0;
                        for (var member = 0; member < bodies.Count; member++) {
                            var bindBody = bodies[member];
                            result += bindBody().Value;
                        }
                        return result;
                    }
                }
            }
            """);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "42");
    }
}
