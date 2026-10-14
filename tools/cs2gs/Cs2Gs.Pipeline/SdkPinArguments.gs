// <copyright file="SdkPinArguments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System

/// Parses the `--sdk-version` and `--sdk-pin` command-line values.
shared class SdkPinArguments {
    /// Returns whether [`version`](paramref) is an acceptable `--sdk-version` value.
    /// @param version The candidate version.
    /// @returns `true` when the version is well-formed.
    func IsValidVersion(version string) bool -> SdkPin.IsValidVersion(version)

    /// Parses an `--sdk-pin` value: `project` or `global-json`.
    /// @param value The command-line value.
    /// @param location The parsed location.
    /// @returns `true` when [`value`](paramref) names a location.
    func TryParseLocation(value string, out location SdkPinLocation) bool {
        if string.Equals(value, "project", StringComparison.Ordinal) {
            location = SdkPinLocation.ProjectFile
            return true
        }
        if string.Equals(value, "global-json", StringComparison.Ordinal) {
            location = SdkPinLocation.GlobalJson
            return true
        }
        location = SdkPinLocation.ProjectFile
        return false
    }
}
