// <copyright file="SdkPinArguments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace Cs2Gs.Pipeline;

#nullable enable annotations

/// <summary>Parses the <c>--sdk-version</c> and <c>--sdk-pin</c> command-line values.</summary>
public static class SdkPinArguments
{
    /// <summary>Returns whether <paramref name="version"/> is an acceptable <c>--sdk-version</c> value.</summary>
    /// <param name="version">The candidate version.</param>
    /// <returns><see langword="true"/> when the version is well-formed.</returns>
    public static bool IsValidVersion(string? version) => SdkPin.IsValidVersion(version);

    /// <summary>Parses an <c>--sdk-pin</c> value: <c>project</c> or <c>global-json</c>.</summary>
    /// <param name="value">The command-line value.</param>
    /// <param name="location">The parsed location.</param>
    /// <returns><see langword="true"/> when <paramref name="value"/> names a location.</returns>
    public static bool TryParseLocation(string? value, out SdkPinLocation location)
    {
        if (string.Equals(value, "project", StringComparison.Ordinal))
        {
            location = SdkPinLocation.ProjectFile;
            return true;
        }

        if (string.Equals(value, "global-json", StringComparison.Ordinal))
        {
            location = SdkPinLocation.GlobalJson;
            return true;
        }

        location = SdkPinLocation.ProjectFile;
        return false;
    }
}
