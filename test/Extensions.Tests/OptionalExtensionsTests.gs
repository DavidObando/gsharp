// <copyright file="OptionalExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import Gsharp.Extensions.Optional
import System
import Xunit

/// Coverage for every public symbol in (cref:OptionalExtensions)
/// (reference-typed nullable receivers). Each helper is exercised on the
/// present-value path, the null path, and any documented edge.
open class OptionalExtensionsTests {
    @Fact
    func Map_OnPresent_AppliesProjection() {
        let value string? = "abc"
        let result = value.Map((s string) -> s.ToUpper())
        Assert.Equal("ABC", result)
    }

    @Fact
    func Map_OnNull_ReturnsNull() {
        let value string? = nil
        let result = value.Map((s string) -> s.ToUpper())
        Assert.Null(result)
    }

    @Fact
    func Map_NullProjection_Throws() {
        let value string? = "abc"
        Assert.Throws[ArgumentNullException](
            func () object? {
                return value.Map[string, string](default((string) -> string))
            }
        )
    }

    @Fact
    func FlatMap_OnPresent_FlattensInnerNullable() {
        let value string? = "hello"
        let result = value.FlatMap(
            func (s string) string? {
                return if s.Length > 0 {
                    s.Substring(0, 1)
                } else {
                    default(string?)
                }
            }
        )
        Assert.Equal("h", result)
    }

    @Fact
    func FlatMap_OnPresent_PropagatesInnerNull() {
        let value string? = ""
        let result = value.FlatMap(
            func (s string) string? {
                return if s.Length > 0 {
                    s.Substring(0, 1)
                } else {
                    default(string?)
                }
            }
        )
        Assert.Null(result)
    }

    @Fact
    func FlatMap_OnNull_ReturnsNull() {
        let value string? = nil
        let result = value.FlatMap(
            func (s string) string? {
                return s.ToUpper()
            }
        )
        Assert.Null(result)
    }

    @Fact
    func OrElse_OnPresent_ReturnsValue() {
        let value string? = "x"
        Assert.Equal("x", value.OrElse("default"))
    }

    @Fact
    func OrElse_OnNull_ReturnsDefault() {
        let value string? = nil
        Assert.Equal("default", value.OrElse("default"))
    }

    @Fact
    func OrElse_NullDefault_ReturnsNullWhenAbsent() {
        let value string? = nil
        // OrElse does not validate non-null defaults — passing null is
        // legal even though the public contract recommends a non-null
        // sentinel.
        Assert.Null(value.OrElse(default(string)))
    }

    @Fact
    func OrCompute_OnPresent_DoesNotCallFactory() {
        var called = 0
        let value string? = "x"
        let result = value.OrCompute(
            func () string {
                called++
                return "default"
            }
        )
        Assert.Equal("x", result)
        Assert.Equal(0, called)
    }

    @Fact
    func OrCompute_OnNull_CallsFactory() {
        var called = 0
        let value string? = nil
        let result = value.OrCompute(
            func () string {
                called++
                return "default"
            }
        )
        Assert.Equal("default", result)
        Assert.Equal(1, called)
    }

    @Fact
    func OrThrow_OnPresent_ReturnsValue() {
        let value string? = "x"
        Assert.Equal("x", value.OrThrow("missing"))
    }

    @Fact
    func OrThrow_OnNull_ThrowsWithMessage() {
        let value string? = nil
        let ex = Assert.Throws[InvalidOperationException](
            func () object? {
                return value.OrThrow("missing")
            }
        )
        Assert.Equal("missing", ex.Message)
    }

    @Fact
    func IfPresent_OnPresent_Invokes() {
        let value string? = "x"
        var captured string? = nil
        value.IfPresent(
            (s string) -> {
                captured = s
            }
        )
        Assert.Equal("x", captured)
    }

    @Fact
    func IfPresent_OnNull_DoesNothing() {
        let value string? = nil
        var called = false
        value.IfPresent(
            (_ string) -> {
                called = true
            }
        )
        Assert.False(called)
    }

    @Fact
    func Filter_PredicateTrue_ReturnsValue() {
        let value string? = "x"
        Assert.Equal("x", value.Filter((s string) -> s.Length == 1))
    }

    @Fact
    func Filter_PredicateFalse_ReturnsNull() {
        let value string? = "xx"
        Assert.Null(value.Filter((s string) -> s.Length == 1))
    }

    @Fact
    func Filter_OnNull_ReturnsNull() {
        let value string? = nil
        Assert.Null(value.Filter((s string) -> s.Length == 1))
    }

    @Fact
    func Chain_MapFilterOrElse_ComposesNaturally() {
        let input string? = "hello world"
        let result = input
            .Map((s string) -> s.ToUpper())
            .Filter((s string) -> s.Contains(' '))
            .Map((s string) -> s.Replace(" ", "_"))
            .OrElse("<empty>")
        Assert.Equal("HELLO_WORLD", result)
    }

    // ----- Value-receiver overloads (where T : struct) ----------------------
    // ADR-0088 / issue #750: prior to this work the value-receiver helpers
    // carried a `*Value` suffix because the G# binder couldn't disambiguate
    // `where T : class` from `where T : struct`. The suffix is gone; the
    // tests below verify the binder picks the struct overload on a
    // Nullable<value-type> receiver and produces correct semantics.
    @Fact
    func Map_ValueReceiver_OnPresent_AppliesProjection() {
        let value int32? = 7
        let result = value.Map((n int32) -> n * 2)
        Assert.Equal(14, result)
    }

    @Fact
    func Map_ValueReceiver_OnNull_ReturnsNull() {
        let value int32? = nil
        let result = value.Map((n int32) -> n * 2)
        Assert.Null(result)
    }

    @Fact
    func Map_ValueReceiver_NullProjection_Throws() {
        let value int32? = 7
        Assert.Throws[ArgumentNullException](
            func () object? {
                return value.Map[int32, int32](default((int32) -> int32))
            }
        )
    }

    @Fact
    func FlatMap_ValueReceiver_OnPresent_FlattensInnerNullable() {
        let value int32? = 7
        let result = value.FlatMap(
            func (n int32) int32? {
                return if n > 0 {
                    int32?(n) * 10
                } else {
                    nil
                }
            }
        )
        Assert.Equal(70, result)
    }

    @Fact
    func FlatMap_ValueReceiver_OnPresent_PropagatesInnerNull() {
        let value int32? = -1
        let result = value.FlatMap(
            func (n int32) int32? {
                return if n > 0 {
                    int32?(n) * 10
                } else {
                    nil
                }
            }
        )
        Assert.Null(result)
    }

    @Fact
    func FlatMap_ValueReceiver_OnNull_ReturnsNull() {
        let value int32? = nil
        let result = value.FlatMap(
            func (n int32) int32? {
                return int32?((n + 1))
            }
        )
        Assert.Null(result)
    }

    @Fact
    func OrElse_ValueReceiver_OnPresent_ReturnsValue() {
        let value int32? = 7
        Assert.Equal(7, value.OrElse(-1))
    }

    @Fact
    func OrElse_ValueReceiver_OnNull_ReturnsDefault() {
        let value int32? = nil
        Assert.Equal(-1, value.OrElse(-1))
    }

    @Fact
    func OrCompute_ValueReceiver_OnPresent_DoesNotCallFactory() {
        var called = 0
        let value int32? = 7
        let result = value.OrCompute(
            () -> {
                called++
                return -1
            }
        )
        Assert.Equal(7, result)
        Assert.Equal(0, called)
    }

    @Fact
    func OrCompute_ValueReceiver_OnNull_CallsFactory() {
        var called = 0
        let value int32? = nil
        let result = value.OrCompute(
            () -> {
                called++
                return 99
            }
        )
        Assert.Equal(99, result)
        Assert.Equal(1, called)
    }

    @Fact
    func OrThrow_ValueReceiver_OnPresent_ReturnsValue() {
        let value int32? = 7
        Assert.Equal(7, value.OrThrow("missing"))
    }

    @Fact
    func OrThrow_ValueReceiver_OnNull_ThrowsWithMessage() {
        let value int32? = nil
        let ex = Assert.Throws[InvalidOperationException](
            func () object? {
                return value.OrThrow("missing")
            }
        )
        Assert.Equal("missing", ex.Message)
    }

    @Fact
    func IfPresent_ValueReceiver_OnPresent_Invokes() {
        let value int32? = 7
        var captured = -1
        value.IfPresent(
            (n int32) -> {
                captured = n
            }
        )
        Assert.Equal(7, captured)
    }

    @Fact
    func IfPresent_ValueReceiver_OnNull_DoesNothing() {
        let value int32? = nil
        var called = false
        value.IfPresent(
            (_ int32) -> {
                called = true
            }
        )
        Assert.False(called)
    }

    @Fact
    func Filter_ValueReceiver_PredicateTrue_ReturnsValue() {
        let value int32? = 7
        Assert.Equal(7, value.Filter((n int32) -> n > 0))
    }

    @Fact
    func Filter_ValueReceiver_PredicateFalse_ReturnsNull() {
        let value int32? = -1
        Assert.Null(value.Filter((n int32) -> n > 0))
    }

    @Fact
    func Filter_ValueReceiver_OnNull_ReturnsNull() {
        let value int32? = nil
        Assert.Null(value.Filter((n int32) -> n > 0))
    }
}
