#!/usr/bin/env swift

import AppKit
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: render-og.swift <background.png> <output.png>\n".utf8))
    exit(64)
}

let backgroundURL = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL
let width = 1280
let height = 640

guard
    let source = CGImageSourceCreateWithURL(backgroundURL, nil),
    let background = CGImageSourceCreateImageAtIndex(source, 0, nil),
    let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
else {
    FileHandle.standardError.write(Data("unable to create image context\n".utf8))
    exit(66)
}

let canvas = CGRect(x: 0, y: 0, width: width, height: height)
context.interpolationQuality = .high
context.draw(background, in: canvas)

let shadeColors = [
    CGColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 0.98),
    CGColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 0.90),
    CGColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 0.18),
    CGColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 0.02),
] as CFArray
let shadeLocations: [CGFloat] = [0, 0.38, 0.66, 1]
if let shade = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: shadeColors, locations: shadeLocations) {
    context.drawLinearGradient(
        shade,
        start: CGPoint(x: 0, y: height / 2),
        end: CGPoint(x: width, y: height / 2),
        options: []
    )
}

func drawText(
    _ text: String,
    baseline: CGPoint,
    size: CGFloat,
    weight: NSFont.Weight,
    color: CGColor,
    kern: CGFloat = 0
) {
    let font = NSFont.systemFont(ofSize: size, weight: weight)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        .kern: kern,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    context.textMatrix = .identity
    context.textPosition = baseline
    CTLineDraw(line, context)
}

drawText(
    "NATIVE MCP RUNTIME FOR macOS",
    baseline: CGPoint(x: 84, y: 510),
    size: 22,
    weight: .semibold,
    color: CGColor(red: 0.51, green: 0.84, blue: 1, alpha: 1),
    kern: 3
)
drawText(
    "AIShell",
    baseline: CGPoint(x: 78, y: 355),
    size: 104,
    weight: .bold,
    color: CGColor(red: 0.96, green: 0.98, blue: 1, alpha: 1),
    kern: -4
)

let ruleColors = [
    CGColor(red: 0.35, green: 0.78, blue: 1, alpha: 1),
    CGColor(red: 0.35, green: 0.78, blue: 1, alpha: 0),
] as CFArray
if let rule = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: ruleColors, locations: [0, 1]) {
    context.saveGState()
    context.addRect(CGRect(x: 84, y: 313, width: 466, height: 3))
    context.clip()
    context.drawLinearGradient(
        rule,
        start: CGPoint(x: 84, y: 314.5),
        end: CGPoint(x: 550, y: 314.5),
        options: []
    )
    context.restoreGState()
}

let primary = CGColor(red: 0.89, green: 0.93, blue: 0.97, alpha: 1)
drawText("Direct OS context", baseline: CGPoint(x: 84, y: 247), size: 32, weight: .medium, color: primary)
drawText("for AI development", baseline: CGPoint(x: 84, y: 205), size: 32, weight: .medium, color: primary)
drawText(
    "Fresh state · bounded context · retained evidence",
    baseline: CGPoint(x: 84, y: 125),
    size: 20,
    weight: .regular,
    color: CGColor(red: 0.63, green: 0.70, blue: 0.77, alpha: 1)
)

guard
    let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(outputURL, UTType.png.identifier as CFString, 1, nil)
else {
    exit(70)
}

CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
    exit(74)
}
