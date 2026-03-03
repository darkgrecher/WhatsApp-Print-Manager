'use client';

import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Typography, message, Space } from 'antd';
import {
  UserOutlined,
  LockOutlined,
  WhatsAppOutlined,
} from '@ant-design/icons';
import { loginApi } from '@/lib/api';
import { useRouter } from 'next/navigation';

const { Title, Text } = Typography;

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      router.push('/dashboard');
    }
  }, [router]);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await loginApi(values.username, values.password);
      localStorage.setItem('admin_token', res.data.access_token);
      message.success('Login successful');
      router.push('/dashboard');
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #e8f5e9 0%, #f1f8e9 100%)',
      }}
    >
      <Card
        style={{ width: 420, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}
        bordered={false}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <WhatsAppOutlined style={{ fontSize: 48, color: '#25D366' }} />
          <Title level={3} style={{ marginTop: 12, marginBottom: 4 }}>
            Admin Portal
          </Title>
          <Text type="secondary">WhatsApp Print Manager</Text>
        </div>

        <Form name="login" onFinish={onFinish} layout="vertical" size="large">
          <Form.Item
            name="username"
            rules={[{ required: true, message: 'Please enter username' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="Username" />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please enter password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Password"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              style={{ height: 44 }}
            >
              Sign In
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
