Pod::Spec.new do |s|
  s.name           = 'ExpoLidarVision'
  s.version        = '0.1.0'
  s.summary        = 'On-device ARKit LiDAR obstacle summaries for PathFinder.'
  s.description    = 'Processes ARKit scene depth locally and emits compact obstacle summaries.'
  s.author         = 'PathFinder'
  s.homepage       = 'https://github.com/pathfinder'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => 'https://github.com/pathfinder/pathfinder.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'AVFoundation', 'Accelerate', 'CoreML', 'Vision'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.9'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.resources = '**/*.mlmodel'
end
